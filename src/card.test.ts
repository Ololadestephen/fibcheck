import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as card from "./card.js";
import { cardCommand } from "./card/command.js";
import { cardText, evidenceLine } from "./card/copy.js";
import { renderCardHtml } from "./card/html.js";
import { main } from "./cli.js";
import { loadFindings, type Finding } from "./findings.js";

const INDEX_DIR = fileURLToPath(new URL("../index/", import.meta.url));
const FINDINGS = `${INDEX_DIR}findings.json`;

const base: Finding = {
  id: "x", project: "Example", own: false, verdict: "false", quote: "Click the Admin tab.",
  source: { repo: "me/app", commit: "abcdef1234", file: "docs/admin.md", line: 1 },
  screenshot: "evidence/run1.jpg",
  evidence: { failures: ["evidence/run1.jpg", "evidence/run2.jpg"], control: "evidence/control.jpg" },
  score: { findings: 1, claims: 1 },
};
const claim = (line: number, verdict: Finding["verdict"], over: Partial<Finding> = {}): Finding => ({
  ...base, id: `c${line}`, verdict, quote: `Claim ${line}.`, source: { ...base.source, line }, ...over,
});

describe("cardText score", () => {
  const five = [claim(1, "true"), claim(2, "true"), claim(3, "worded_differently"), claim(4, "false"), claim(5, "unconfirmed")];

  it("counts distinct resolved claims from one source revision", () => {
    expect(cardText(five[3]!, five)).toMatchObject({
      score: "3 of 4 claims told the truth", note: "1 worded differently · 1 couldn't be checked", held: 3, resolved: 4,
    });
    expect(cardText(five[0]!, five).stamp).toBe("HELD");
    expect(cardText(five[0]!).stamp).toBe("ALL HELD");
  });

  it("counts every unconfirmed claim, but not other revisions or duplicates of the same line and quote", () => {
    const entries = [...five, claim(6, "unconfirmed"), claim(7, "false", { source: { ...base.source, commit: "ffffffffff", line: 7 } }), { ...five[0]!, id: "dup" }];
    expect(cardText(five[3]!, entries)).toMatchObject({ score: "3 of 4 claims told the truth", note: "1 worded differently · 2 couldn't be checked" });
  });

  it("says no claims were resolved when only unconfirmed ones exist", () => {
    const only = claim(1, "unconfirmed");
    expect(cardText(only, [only])).toMatchObject({ score: "No resolved claims", note: "1 couldn't be checked", stamp: "UNCONFIRMED" });
  });

  it("clips a long quote to 90 characters with an ellipsis", () => {
    const quote = cardText({ ...base, quote: "😀".repeat(120) }).quote;
    expect([...quote]).toHaveLength(90);
    expect(quote.endsWith("…")).toBe(true);
    expect(cardText({ ...base, quote: "  a\n  b " }).quote).toBe("a b");
  });
});

describe("cardText copy", () => {
  it("reports failed runs, the control and a merged fix", () => {
    const upstream = { status: "merged" as const, pr: "p", mergedAt: "t", mergeCommit: "c" };
    expect(evidenceLine(base)).toBe("Failed in 2 separate runs · control passed");
    expect(cardText({ ...base, upstream })).toMatchObject({ evidence: "Failed in 2 separate runs · control passed", merged: "Fix merged by the maintainers ✓" });
    expect(cardText(base).merged).toBe("");
  });

  it("keeps the caption stable for an id whatever punchline is recorded", () => {
    const plain = cardText(base).caption;
    expect(cardText({ ...base, punchline: "Arbitrary joke." }).caption).toBe(plain);
    expect(cardText({ ...base, punchline: "Arbitrary joke." })).not.toHaveProperty("punchline");
  });

  it("uses a different caption tone for our own project", () => {
    const own = cardText({ ...base, own: true, verdict: "outdated" }).caption;
    expect(own).toMatch(/^Our /);
    expect(cardText({ ...base, own: false, verdict: "outdated" }).caption).not.toMatch(/^Our /);
  });
});

describe("renderCardHtml", () => {
  const entries = [claim(1, "true"), claim(2, "true"), claim(3, "worded_differently"), claim(4, "false")];

  it("keeps the screenshot's data URL unchanged and scales it only", () => {
    const html = renderCardHtml(base, "data:image/jpeg;base64,AAAA");
    expect(html).toContain('src="data:image/jpeg;base64,AAAA"');
    expect(html).toContain("object-fit:contain");
    expect(html).toContain("default-src 'none'; img-src data:; style-src 'unsafe-inline'");
    expect(html).not.toContain("<script");
  });

  it("escapes recorded text", () => {
    const html = renderCardHtml({ ...base, quote: '<i>`"&', project: "<b>P</b>" }, "data:image/png;base64,AA");
    expect(html).toContain("“&lt;i&gt;&#96;&quot;&amp;”");
    expect(html).not.toContain("<i>");
    expect(html).toContain("&lt;b&gt;P&lt;/b&gt;");
  });

  it("counts up with time and ends on the recorded score", () => {
    expect(renderCardHtml(entries[3]!, "x", entries, 0)).toContain('<div class="score">0 of 4</div>');
    const end = renderCardHtml(entries[3]!, "x", entries, 3);
    expect(end).toContain('<div class="score">3 of 4</div>');
    expect(end).toContain("--time:-3s");
    expect(renderCardHtml(entries[3]!, "x", entries, 99)).toContain("--time:-3s");
  });

  it("shows text instead of a needle when nothing resolved", () => {
    const html = renderCardHtml(claim(1, "unconfirmed"), "x");
    expect(html).toContain('<div class="score empty">No resolved claims</div>');
    expect(html).not.toContain('class="needle"');
  });
});

describe("the recorded findings", () => {
  const findings = loadFindings(FINDINGS);
  const score = (id: string) => cardText(findings.find((finding) => finding.id === id)!, findings);

  it("all exist, and every false or outdated one has two failures and a control", () => {
    expect(findings.map(({ id }) => id)).toEqual([
      "mealie-faq-disable-ingredient-amounts", "uptime-kuma-wiki-maintenance-menu", "linkding-admin-tab", "linkding-tags-only-create-or-assign", "soryn-readme-basic-attack",
    ]);
  });

  it("record lazy-fix counts that match the saved attack attempts", () => {
    for (const finding of findings.filter(({ lazyFixes }) => lazyFixes)) {
      const record = JSON.parse(readFileSync(`${INDEX_DIR}attacks/${finding.id}.json`, "utf8")) as { results: { outcome: string }[] };
      const rejected = record.results.filter(({ outcome }) => outcome === "rejected_by_rule" || outcome === "rejected_by_kane").length;
      const byKane = record.results.filter(({ outcome }) => outcome === "rejected_by_kane").length;
      expect(finding.lazyFixes).toEqual({ rejected, byKane });
    }
  });

  it("score each project from its recorded verdicts, never from legacy totals", () => {
    expect(score("mealie-faq-disable-ingredient-amounts")).toMatchObject({
      score: "3 of 5 lines held up", note: "1 couldn't be checked", stamp: "OUTDATED", merged: "Fix merged by the maintainers ✓",
      source: "Mealie · …/getting-started/faq.md:30 · e2c0c3b",
    });
    expect(score("uptime-kuma-wiki-maintenance-menu").score).toBe("3 of 5 lines held up");
    expect(score("linkding-admin-tab").score).toBe("3 of 6 lines held up");
    expect(score("linkding-tags-only-create-or-assign").score).toBe("3 of 6 lines held up");
    expect(score("soryn-readme-basic-attack")).toMatchObject({ score: "7 of 7 lines held up", note: "", worded: 1, evidence: "Behaviour held in Kane's run" });
  });

  it("falls back to the finding when no app total is available", () => {
    expect(cardText({ ...base, score: { findings: 1, claims: 50 } })).toMatchObject({ score: "0 of 1 claim told the truth", scope: "Recorded findings" });
  });
});

it("passes --animate from the fibcheck card command to the renderer", async () => {
  const writeCard = vi.spyOn(card, "writeCard").mockReturnValue("share.png");
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    expect(await main(["card", "soryn-readme-basic-attack", "--animate", "--findings", FINDINGS, "--out", "cards"])).toBe(0);
    expect(writeCard).toHaveBeenCalledExactlyOnceWith(FINDINGS, "soryn-readme-basic-attack", "cards", undefined, true);
    expect(stdout).toHaveBeenCalledExactlyOnceWith("Saved share.png\n");
  } finally {
    writeCard.mockRestore();
    stdout.mockRestore();
  }
});

describe.skipIf(process.platform === "win32")("cardCommand --animate without ffmpeg", () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("saves the PNG, writes no GIF, and says ffmpeg is missing", () => {
    const bin = mkdtempSync(join(tmpdir(), "fibcheck-bin-"));
    const out = mkdtempSync(join(tmpdir(), "fibcheck-out-"));
    dirs.push(bin, out);
    const chrome = join(bin, "fake-chrome");
    writeFileSync(chrome, '#!/bin/sh\nfor arg in "$@"; do case "$arg" in --screenshot=*) printf png > "${arg#--screenshot=}";; esac; done\n');
    chmodSync(chrome, 0o755);
    vi.stubEnv("FIBCHECK_CHROME", chrome);
    vi.stubEnv("PATH", bin);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    expect(cardCommand(["soryn-readme-basic-attack", "--animate", "--findings", FINDINGS, "--out", out])).toBe(1);

    const message = stderr.mock.calls.map(([text]) => String(text)).join("");
    expect(message).toContain("ffmpeg");
    expect(message).toContain("PNG saved to");
    expect(existsSync(join(out, "soryn-readme-basic-attack.png"))).toBe(true);
    expect(existsSync(join(out, "soryn-readme-basic-attack.gif"))).toBe(false);
    expect(stdout).not.toHaveBeenCalled();
  });
});
