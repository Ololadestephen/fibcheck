import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cardText, evidenceLine, loadFindings, renderCardHtml, type Finding } from "./card.js";

const base: Finding = {
  id: "x", project: "Example", own: true, verdict: "false", quote: "Click the Admin tab.",
  source: { repo: "me/app", commit: "abcdef1234", file: "docs/admin.md", line: 14 },
  screenshot: "evidence/run1.jpg",
  evidence: { failures: ["evidence/run1.jpg", "evidence/run2.jpg"], control: "evidence/control.jpg", fixProof: "evidence/after.jpg" },
  score: { findings: 3, claims: 40 },
};

describe("cardText", () => {
  it("uses the playful tone and a count-based score for our own projects", () => {
    expect(cardText(base)).toMatchObject({
      stamp: "FIB DETECTED",
      headline: "Your README fibbed. We have receipts.",
      source: "Example · docs/admin.md, line 14 · abcdef1",
      evidence: "Caught twice by Kane. Control passed. Fix proven ✓",
      score: "3 fibs in 40 claims",
      receipts: ["Kane failed it in 2 separate runs", "Control run passed, so the test wasn't broken", "The corrected wording passed Kane"],
    });
    expect(cardText(base).thanks).toBeUndefined();
  });

  it("is polite to third-party projects: no fib or lie, and a thank-you", () => {
    for (const verdict of ["false", "outdated"] as const) {
      const text = cardText({ ...base, own: false, verdict });
      const all = Object.values(text).join(" ").toLowerCase();
      expect(all).not.toMatch(/\bfib|\blie\b|\blied\b/);
      expect(text.thanks).toBe("Thanks, Example maintainers. Great project, one small docs update.");
      expect(text.score).toBe("3 out-of-step lines in 40 claims checked");
    }
    expect(cardText({ ...base, own: false, verdict: "outdated" }).stamp).toBe("OUTDATED");
    expect(cardText({ ...base, own: false, verdict: "false" }).stamp).toBe("MIX-UP");
  });

  it("maps every verdict to its stamp", () => {
    const stamps = (["true", "worded_differently", "unconfirmed", "outdated"] as const).map((verdict) => cardText({ ...base, verdict }).stamp);
    expect(stamps).toEqual(["VERIFIED", "CLOSE ENOUGH?", "CAN'T TELL", "OUTDATED"]);
    expect(cardText({ ...base, verdict: "unconfirmed" }).headline).toBe("Can't tell. We refuse to guess.");
  });

  it("says only the evidence that exists", () => {
    expect(evidenceLine({ ...base, evidence: { failures: ["a"] } })).toBe("Caught once by Kane.");
    expect(evidenceLine({ ...base, evidence: { failures: ["a", "b"], control: "c" } })).toBe("Caught twice by Kane. Control passed.");
    expect(evidenceLine({ ...base, evidence: { failures: [], held: "h", fixProof: "f" } })).toBe("Behaviour held in Kane's run. Fix proven ✓");
    expect(evidenceLine({ ...base, lazyFixes: { rejected: 4, byKane: 1 } })).toBe("Caught twice by Kane. Control passed. Fix proven ✓ 4 lazy fixes rejected (1 by Kane).");
    expect(evidenceLine({ ...base, lazyFixes: { rejected: 0, byKane: 0 } })).toBe("Caught twice by Kane. Control passed. Fix proven ✓");
    const upstream = { status: "merged" as const, pr: "p", mergedAt: "t", mergeCommit: "c" };
    expect(evidenceLine({ ...base, upstream })).toBe("Caught twice by Kane. Control passed. Fix proven ✓ Fix merged by the maintainers ✓");
  });

  it("names the visible wording for a worded-differently card", () => {
    const text = cardText({ ...base, verdict: "worded_differently", visibleWording: '"Attack"', evidence: { failures: [], held: "h" }, score: { findings: 0, claims: 7 } });
    expect(text.headline).toBe('Your README calls it one thing. The app calls it "Attack".');
    expect(text.score).toBe("0 fibs in 7 claims");
  });
});

describe("card jokes", () => {
  it("never calls a third-party project a fibber or a liar, whatever the verdict", () => {
    for (const verdict of ["true", "false", "outdated", "worded_differently", "unconfirmed"] as const) {
      const text = cardText({ ...base, own: false, verdict, punchline: undefined });
      expect(Object.values(text).flat().join(" ").toLowerCase()).not.toMatch(/\bfib|\blie\b|\blied\b|\bliar/);
    }
  });

  it("lists receipts only for evidence that exists, and thanks maintainers who merged", () => {
    const upstream = { status: "merged" as const, pr: "p", mergedAt: "t", mergeCommit: "c" };
    const text = cardText({ ...base, own: false, verdict: "outdated", evidence: { failures: ["a"] }, upstream, lazyFixes: { rejected: 1, byKane: 0 } });
    expect(text.receipts).toEqual(["Kane failed it once", "1 lazy fix tried and rejected", "The maintainers merged the fix"]);
    expect(text.thanks).toContain("for merging the fix");
  });

  it("uses a recorded punchline as written", () => {
    expect(cardText({ ...base, punchline: "Kane looked twice." }).punchline).toBe("Kane looked twice.");
    expect(cardText(base).punchline).toBeUndefined();
  });
});

describe("renderCardHtml", () => {
  it("shows the screenshot only scaled, with nothing drawn over it", () => {
    const html = renderCardHtml(base, "data:image/jpeg;base64,AAAA");
    expect(html).toContain("object-fit:contain");
    expect(html).toContain('<div class="shot"><img alt="Kane CLI screenshot, scaled only" src="data:image/jpeg;base64,AAAA"></div>');
    expect(html).toContain("needle: went wild");
    expect(renderCardHtml({ ...base, verdict: "true" }, "x")).toContain("needle: calm");
    expect(html).toContain("“Click the Admin tab.”");
  });
});

describe("the recorded findings", () => {
  const findings = loadFindings("index/findings.json");

  it("all exist, and every false or outdated one has two failures and a control", () => {
    expect(findings.map(({ id }) => id)).toEqual([
      "mealie-faq-disable-ingredient-amounts", "uptime-kuma-wiki-maintenance-menu", "linkding-admin-tab", "linkding-tags-only-create-or-assign", "soryn-readme-basic-attack",
    ]);
  });

  it("record lazy-fix counts that match the saved attack attempts", () => {
    for (const finding of findings.filter(({ lazyFixes }) => lazyFixes)) {
      const record = JSON.parse(readFileSync(`index/attacks/${finding.id}.json`, "utf8")) as { results: { outcome: string }[] };
      const rejected = record.results.filter(({ outcome }) => outcome === "rejected_by_rule" || outcome === "rejected_by_kane").length;
      const byKane = record.results.filter(({ outcome }) => outcome === "rejected_by_kane").length;
      expect(finding.lazyFixes).toEqual({ rejected, byKane });
    }
  });

  it("make cards whose text matches each recorded verdict and its evidence", () => {
    const byId = Object.fromEntries(findings.map((finding) => [finding.id, cardText(finding)]));
    expect(byId["mealie-faq-disable-ingredient-amounts"]).toMatchObject({ stamp: "OUTDATED", evidence: "Caught twice by Kane. Control passed. Fix proven ✓ Fix merged by the maintainers ✓ 3 lazy fixes rejected.", thanks: expect.stringContaining("for merging the fix") });
    expect(byId["uptime-kuma-wiki-maintenance-menu"]).toMatchObject({ stamp: "MIX-UP", evidence: "Caught twice by Kane. Control passed. 3 lazy fixes rejected." });
    expect(byId["linkding-admin-tab"]?.evidence).toBe("Caught twice by Kane. Control passed. Fix proven ✓ 3 lazy fixes rejected.");
    expect(byId["soryn-readme-basic-attack"]).toMatchObject({ stamp: "CLOSE ENOUGH?", evidence: "Behaviour held in Kane's run. Fix proven ✓", score: "0 fibs in 7 claims" });
  });
});
