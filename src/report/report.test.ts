import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CheckReport } from "../check.js";
import type { Claim } from "../claims/types.js";
import { main } from "../cli.js";
import { parseKaneOutput } from "../kane/parse.js";
import type { KaneRun } from "../kane/runner.js";
import { writeReport } from "./report.js";

const tab: Claim = {
  id: "README.md#L1",
  type: "ui_flow",
  quote: "Click the <Admin> tab.",
  source: { file: "README.md", startLine: 1, endLine: 1 },
};
const other: Claim = {
  id: "README.md#L2",
  type: "behaviour",
  quote: "You can manage tags.",
  source: { file: "README.md", startLine: 2, endLine: 2 },
};
const unsupported: Claim = {
  id: "README.md#L3",
  type: "untestable",
  quote: "It opens a new window.",
  reason: "Window state is unavailable.",
  source: { file: "README.md", startLine: 3, endLine: 3 },
};

describe("fibcheck report", () => {
  let directory: string;
  let input: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "fibcheck-report-"));
    input = join(directory, "check.json");
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });

  it("labels saved Kane results, shows every claim and links evidence in a moved run", async () => {
    const evidenceDir = join(directory, "claims", "admin", "evidence");
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(join(evidenceDir, "step one.png"), "");
    writeFileSync(join(directory, "internal.png"), "");
    const kane: KaneRun = {
      ...parseKaneOutput('{"type":"run_end","status":"failed","one_liner":"No tab."}', 1),
      objective: "Open Settings.",
      startUrl: "",
      outDir: "/original/run/claims/admin",
      evidenceError: null,
      evidence: [{
        ordinal: 1,
        kind: "assert",
        status: "failed",
        summary: "Check the tab.",
        url: "",
        screenshot: "step one.png",
        annotated: "../../../internal.png",
        failureYaml: null,
      }, {
        ordinal: 2,
        kind: "assert",
        status: "failed",
        summary: "Try again.",
        url: "",
        screenshot: "missing.png",
        annotated: null,
        failureYaml: null,
      }],
    };
    saveCheck(input, [tab, other, unsupported], [{ claim: tab, kane }], [other.id]);

    expect(await main(["report", input])).toBe(0);
    const html = readFileSync(join(directory, "report.html"), "utf8");
    expect(html).toContain("<dt>Kane failed</dt><dd>1</dd>");
    expect(html).toContain("<dt>Not run</dt><dd>1</dd>");
    expect(html).toContain("<dt>Untestable</dt><dd>1</dd>");
    expect(html).toContain("Click the &lt;Admin&gt; tab.");
    expect(html).toContain("README.md · line 1");
    expect(html).toContain(other.quote);
    expect(html).toContain(unsupported.reason);
    expect(html).toContain("No tab.");
    expect(html).toContain('href="claims/admin/evidence/step%20one.png"');
    expect(html).not.toContain("internal.png");
    expect(html).not.toContain("missing.png");
    expect(html).toContain("Screenshot unavailable");
    expect(readFileSync(join(directory, "badge.svg"), "utf8")).toContain("1 claim tested by Kane");
  });

  it("produces a zero-count badge when no claims were run", async () => {
    saveCheck(input, [other], [], [other.id]);
    expect(await main(["report", input])).toBe(0);
    expect(readFileSync(join(directory, "report.html"), "utf8")).toContain("No Kane runs in this check.");
    expect(readFileSync(join(directory, "badge.svg"), "utf8")).toContain("0 claims tested by Kane");
  });

  it("shows the verdict, retry, control and blame override for a questioned claim", async () => {
    const kane: KaneRun = {
      ...parseKaneOutput('{"type":"run_end","status":"failed","one_liner":"No tab."}', 1),
      objective: "Open Settings.", startUrl: "", outDir: directory, evidenceError: null, evidence: [],
    };
    const control = { ...kane, status: "passed" as const, oneLiner: "The administration dashboard loaded." };
    saveCheck(input, [tab], [{ claim: tab, kane, questioning: {
      verdict: "outdated", reason: "Two separate runs failed the tab assertion.", initialReason: "Check the documented tab.",
      followUps: [{ purpose: "retry", reason: "Inspect the in-page navigation again.", kane }, { purpose: "control", reason: "Check access through the dropdown.", kane: control }],
      overrides: [{ round: "initial", family: "automation_bug", category: "test_data_issue", hypothesis: "Kane attributed the failure to missing administrator access.", evidence: "The same login opened the dashboard." }],
    } }], []);

    expect(await main(["report", input])).toBe(0);
    const html = readFileSync(join(directory, "report.html"), "utf8");
    expect(html).toContain("Verdict outdated");
    expect(html).toContain("<dt>Outdated</dt><dd>1</dd>");
    expect(html).toContain("<dt>False</dt><dd>0</dd>");
    expect(html).toContain("Reproduction · Kane failed");
    expect(html).toContain("Control · Kane passed");
    expect(html).toContain("Blame override");
    expect(html).toContain("missing administrator access");
    expect(html).toContain("The same login opened the dashboard.");
    const badge = readFileSync(join(directory, "badge.svg"), "utf8");
    expect(badge).toContain("1 confirmed finding");
    expect(badge).toContain('data-state="findings"');
  });

  it("distinguishes false, unconfirmed and legacy runs in the score and marks findings on the badge", () => {
    const first = { ...tab, id: "first" };
    const second = { ...tab, id: "second" };
    const third = { ...tab, id: "third" };
    const legacy = { ...tab, id: "legacy" };
    const kane = sampleRun(directory, "failed", 1);
    const questioning = { reason: "Evidence reviewed.", initialReason: "Run the check.", followUps: [], overrides: [] };
    saveCheck(input, [first, second, third, legacy], [
      { claim: first, kane, questioning: { ...questioning, verdict: "false" } },
      { claim: second, kane, questioning: { ...questioning, verdict: "outdated" } },
      { claim: third, kane, questioning: { ...questioning, verdict: "unconfirmed" } },
      { claim: legacy, kane },
    ], []);

    const { htmlPath, badgePath } = writeReport(input);
    const html = readFileSync(htmlPath, "utf8");
    for (const label of ["False", "Outdated", "Unconfirmed", "Without verdict"]) {
      expect(html).toContain(`<dt>${label}</dt><dd>1</dd>`);
    }
    const badge = readFileSync(badgePath, "utf8");
    expect(badge).toContain("2 confirmed findings");
    expect(badge).toContain('data-state="findings"');
  });

  it("certifies a nonempty set of tested claims only with true verdicts and Kane passes", () => {
    const kane = sampleRun(directory, "passed", 0);
    const questioning = { verdict: "true" as const, reason: "Kane confirmed the assertion.", initialReason: "Run the check.", followUps: [], overrides: [] };
    const badgeFor = (entries: CheckReport["tested"]) => {
      saveCheck(input, [tab, other], entries, [other.id]);
      return readFileSync(writeReport(input).badgePath, "utf8");
    };
    expect(badgeFor([{ claim: tab, kane, questioning }])).toContain("Kane swore it&#39;s true · 1 tested");
    expect(badgeFor([{ claim: tab, kane }])).toContain("1 claim tested by Kane");
    expect(badgeFor([{ claim: tab, kane: sampleRun(directory, "failed", 1), questioning }])).toContain("1 claim tested by Kane");
  });

  it("rejects a file that is not a saved check", () => {
    writeFileSync(input, JSON.stringify({ unrelated: true }));
    expect(() => writeReport(input)).toThrow("Expected a saved fibcheck check");
    expect(existsSync(join(directory, "report.html"))).toBe(false);
    expect(existsSync(join(directory, "badge.svg"))).toBe(false);
  });
});

function sampleRun(outDir: string, status: "passed" | "failed", exitCode: number): KaneRun {
  return {
    ...parseKaneOutput(JSON.stringify({ type: "run_end", status }), exitCode),
    objective: "Open Settings.", startUrl: "", outDir, evidenceError: null, evidence: [],
  };
}

function saveCheck(path: string, claims: Claim[], tested: CheckReport["tested"], notTested: string[]): void {
  const report: CheckReport = {
    runId: "sample",
    target: "Demo",
    repo: "test-repository",
    commit: null,
    startedAt: "2026-11-16T00:00:00Z",
    finishedAt: "2026-11-16T00:01:00Z",
    documents: ["README.md"],
    claims,
    rejected: [],
    tested,
    notTested,
    kaneCredits: 0,
    model: { calls: 0, inputTokens: 0, outputTokens: 0, cacheHits: 0 },
  };
  writeFileSync(path, JSON.stringify(report));
}
