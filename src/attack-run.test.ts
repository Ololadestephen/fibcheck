import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attackFinding, attackObjective } from "./attack-run.js";
import { runKane, type KaneRun } from "./kane/runner.js";
import { CallBudget } from "./model/budget.js";
import { ModelClient } from "./model/client.js";
import type { ModelProvider } from "./model/types.js";

vi.mock("./kane/runner.js", { spy: true });

describe("attackObjective", () => {
  it("shows the proposed line, keeps login placeholders and breaks up braces in model text", () => {
    const text = attackObjective("Sign in as {{user}}.", { kind: "wrong", text: "Open {{Settings}}.", check: "Go to http://localhost:3001/settings and assert a Maintenance tab." });
    expect(text).toBe('Sign in as {{user}}. Proposed documentation says: "Open { {Settings} }.". Go to the app\'s /settings page and assert a Maintenance tab.');
  });
});

describe("attackFinding", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const setup = (entry: Record<string, unknown>, provider: ModelProvider = { name: "unused", async generate() { throw new Error("not called"); } }) => {
    const dir = mkdtempSync(join(tmpdir(), "fibcheck-attack-run-"));
    dirs.push(dir);
    mkdirSync(join(dir, "evidence"));
    for (const file of ["a.jpg", "b.jpg", "c.jpg"]) writeFileSync(join(dir, "evidence", file), "x");
    const findingsPath = join(dir, "findings.json");
    writeFileSync(findingsPath, JSON.stringify([{
      id: "f", project: "P", own: false, quote: "Click the Admin tab.", source: { repo: "r", commit: "c", file: "docs.md", line: 1 },
      screenshot: "evidence/a.jpg", evidence: { failures: ["evidence/a.jpg", "evidence/b.jpg"], control: "evidence/c.jpg" }, score: { findings: 1, claims: 2 },
      ...entry,
    }]));
    const client = new ModelClient(provider, new CallBudget({ maxCallsPerRun: 5, maxCallsTotal: 5 }, "r", join(dir, "t"), join(dir, "l")));
    return { client, findingsPath, runsDir: join(dir, "runs") };
  };

  it("refuses a finding that is not false or outdated", async () => {
    const { client, findingsPath, runsDir } = setup({ verdict: "worded_differently", evidence: { failures: [], held: "evidence/a.jpg" } });
    await expect(attackFinding(client, { findingsPath, id: "f", appUrl: "https://app.test", runsDir })).rejects.toThrow("only false or outdated");
  });

  it("refuses a finding without a proven fix", async () => {
    const { client, findingsPath, runsDir } = setup({ verdict: "outdated" });
    await expect(attackFinding(client, { findingsPath, id: "f", appUrl: "https://app.test", runsDir })).rejects.toThrow("no proven fix");
  });

  it("rejects an app address with a password or a non-web scheme before anything runs", async () => {
    const { client, findingsPath, runsDir } = setup({ verdict: "outdated", fix: "Open Settings." });
    await expect(attackFinding(client, { findingsPath, id: "f", appUrl: "https://user:pass@example.org", runsDir })).rejects.toThrow("must not contain a user name or password");
    await expect(attackFinding(client, { findingsPath, id: "f", appUrl: "ftp://example.org", runsDir })).rejects.toThrow("must start with http:// or https://");
  });

  it("records every attempt, saves the attack file and tallies the rejections on the finding", async () => {
    const reply = (value: unknown) => ({ text: JSON.stringify(value), model: "fake", usage: { inputTokens: 1, outputTokens: 1 } });
    const provider: ModelProvider = {
      name: "fake",
      async generate(request, beforeAttempt) {
        beforeAttempt();
        if (request.purpose === "attack-lazy-fixes") {
          return reply({ vague: "Click a tab.", hedge: "You may click the Admin tab.", wrong: "Open Settings and click the Integrations tab in the header.", check: "Open the Settings page and click the Integrations tab." });
        }
        return reply({ exercisedClaim: true, cause: "claim_contradicted", reason: "No such tab.", ownMistakeRuledOut: "Signed in fine.", kaneBlame: "agree", blameEvidence: "", revisedCheck: "", controlCheck: "" });
      },
    };
    const { client, findingsPath, runsDir } = setup({
      verdict: "outdated", fix: "Open Settings, then the Profile page, and click the Admin button in the header.",
    }, provider);
    const failed: KaneRun = {
      status: "failed", exitCode: 1, oneLiner: "No Integrations tab.", summary: "", reason: "", reasonCode: "", durationSec: null, credits: null,
      testUrl: null, sessionDir: null, evidencePack: null, steps: [], failedStep: null, observations: [], blame: null, ignoredLines: 0,
      objective: "o", startUrl: "https://app.test", outDir: join(runsDir, "f-wrong-1"), evidence: [], evidenceError: null,
    };
    vi.mocked(runKane).mockResolvedValue(failed);

    const record = await attackFinding(client, { findingsPath, id: "f", appUrl: "https://app.test", runsDir });

    expect(record.results.map(({ kind, outcome }) => `${kind}:${outcome}`)).toEqual([
      "delete:rejected_by_rule", "vague:rejected_by_rule", "hedge:rejected_by_rule", "wrong:rejected_by_kane",
    ]);
    expect(vi.mocked(runKane)).toHaveBeenCalledTimes(1);
    const attackFile = join(dirname(findingsPath), "attacks", "f.json");
    expect(existsSync(attackFile)).toBe(true);
    const saved = JSON.parse(readFileSync(attackFile, "utf8")) as { appUrl: string; results: { kind: string; kane?: unknown }[] };
    expect(saved.appUrl).toBe("https://app.test");
    expect(saved.results.at(-1)?.kane).toEqual({ status: "failed", oneLiner: "No Integrations tab." });
    const findings = JSON.parse(readFileSync(findingsPath, "utf8")) as { lazyFixes?: unknown }[];
    expect(findings[0]?.lazyFixes).toEqual({ rejected: 4, byKane: 1 });
  });
});
