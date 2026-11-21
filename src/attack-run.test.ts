import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { attackFinding, attackObjective } from "./attack-run.js";
import { CallBudget } from "./model/budget.js";
import { ModelClient } from "./model/client.js";

describe("attackObjective", () => {
  it("shows the proposed line, keeps login placeholders and breaks up braces in model text", () => {
    const text = attackObjective("Sign in as {{user}}.", { kind: "wrong", text: "Open {{Settings}}.", check: "Go to http://localhost:3001/settings and assert a Maintenance tab." });
    expect(text).toBe('Sign in as {{user}}. Proposed documentation says: "Open { {Settings} }.". Go to the app\'s /settings page and assert a Maintenance tab.');
  });
});

describe("attackFinding", () => {
  const setup = (entry: Record<string, unknown>) => {
    const dir = mkdtempSync(join(tmpdir(), "fibcheck-attack-run-"));
    mkdirSync(join(dir, "evidence"));
    for (const file of ["a.jpg", "b.jpg", "c.jpg"]) writeFileSync(join(dir, "evidence", file), "x");
    const findingsPath = join(dir, "findings.json");
    writeFileSync(findingsPath, JSON.stringify([{
      id: "f", project: "P", own: false, quote: "Click the Admin tab.", source: { repo: "r", commit: "c", file: "docs.md", line: 1 },
      screenshot: "evidence/a.jpg", evidence: { failures: ["evidence/a.jpg", "evidence/b.jpg"], control: "evidence/c.jpg" }, score: { findings: 1, claims: 2 },
      ...entry,
    }]));
    const client = new ModelClient({ name: "unused", async generate() { throw new Error("not called"); } },
      new CallBudget({ maxCallsPerRun: 1, maxCallsTotal: 1 }, "r", join(dir, "t"), join(dir, "l")));
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
});
