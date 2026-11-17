import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { startApp } from "./app/docker.js";
import { objectiveFor, runCheck } from "./check.js";
import { cacheKey, extractClaimsCached } from "./claims/cache.js";
import type { Claim } from "./claims/types.js";
import { parseKaneOutput } from "./kane/parse.js";
import { runKane } from "./kane/runner.js";
import { CallBudget } from "./model/budget.js";
import { ModelClient } from "./model/client.js";
import type { ModelProvider } from "./model/types.js";
import { loadTarget, resolveTarget, targetPathFor } from "./target.js";

vi.mock("./app/docker.js", { spy: true });
vi.mock("./kane/runner.js", { spy: true });

const claim: Claim = {
  id: "docs/admin.md#L14",
  type: "ui_flow",
  quote: "go the *Settings* view and click on the *Admin* tab",
  source: { file: "docs/admin.md", startLine: 14, endLine: 14 },
  check: "Open Settings and verify there is an Admin tab.",
};

describe("targets", () => {
  it("generates one secret per name, shares it between Docker and Kane, and marks it secret", () => {
    const target = resolveTarget(
      { name: "t", repo: ".", app: { image: "img", port: 1, containerPort: 2, env: { A: "{{secret:pw}}", B: "x-{{secret:pw}}", C: "plain" } } },
      () => "S3CRET",
    );
    expect(target.resolvedEnv).toEqual({ A: "S3CRET", B: "x-S3CRET", C: "plain" });
    expect(target.kaneVariables).toEqual({ pw: { value: "S3CRET", secret: true } });
    expect(target.baseUrl).toBe("http://localhost:1");
  });

  it("rejects a target without an app image", () => {
    const path = join(mkdtempSync(join(tmpdir(), "pino-t-")), "t.json");
    writeFileSync(path, JSON.stringify({ name: "t", repo: ".", app: { port: 1, containerPort: 2 } }));
    expect(() => loadTarget(path)).toThrow(/app.image/);
  });

  it("loads the shipped linkding target", () => {
    const target = loadTarget("targets/linkding.json");
    expect(target.login).toContain("{{app_pass}}");
    expect(target.app.env?.LD_SUPERUSER_PASSWORD).toBe("{{secret:app_pass}}");
  });

  it("locates the bundled profile by repository or GitHub clone URL", () => {
    const file = "targets/linkding.json";
    const expected = loadTarget(file);
    expect(targetPathFor(file)).toBe(file);
    expect(loadTarget(targetPathFor("sissbruecker/linkding"))).toEqual(expected);
    expect(loadTarget(targetPathFor(expected.repo + ".git"))).toEqual(expected);
    expect(() => targetPathFor(expected.repo + "/tree/main")).toThrow(/No target file or bundled repository/);
    expect(() => targetPathFor("owner/other-app")).toThrow(/target JSON/);
  });
});

describe("objectiveFor", () => {
  it("puts the login, the documented claim and the check together", () => {
    const text = objectiveFor(claim, { login: "Log in with {{app_pass}}." });
    expect(text).toBe(
      'Log in with {{app_pass}}. The app\'s documentation (docs/admin.md, line 14) says: "go the *Settings* view and click on the *Admin* tab". Open Settings and verify there is an Admin tab.',
    );
  });

  it("breaks up braces in quoted text so Kane does not read them as variables", () => {
    const text = objectiveFor({ ...claim, quote: "use {{name}} here", check: "Type {{x}}." }, { login: undefined });
    expect(text).not.toContain("{{");
  });
});

describe("check Kane run limit", () => {
  it.each([0, 1])("starts at most %i Kane rounds and saves all skipped claim IDs", async (limit) => {
    const dir = mkdtempSync(join(tmpdir(), "pino-budget-"));
    const stop = vi.fn(async () => {});
    vi.mocked(startApp).mockResolvedValue({ containerName: "disposable", baseUrl: "http://localhost:1", stop });
    vi.mocked(runKane).mockImplementation(async ({ objective, startUrl, outDir }) => ({
      ...parseKaneOutput('{"type":"run_end","status":"passed"}', 0),
      objective, startUrl, outDir, evidence: [], evidenceError: null,
    }));
    try {
      const quotes = ["Toggle dark mode", "Download a backup"];
      writeFileSync(join(dir, "README.md"), quotes.join("\n"));
      const targetPath = join(dir, "target.json");
      writeFileSync(targetPath, JSON.stringify({ name: "t", repo: dir, app: { image: "test", port: 1, containerPort: 2 } }));
      const provider: ModelProvider = {
        name: "fake",
        async generate(_request, before) {
          before();
          const claims = quotes.map((quote, i) => ({
            quote, startLine: i + 1, endLine: i + 1, type: "behaviour", check: quote,
          }));
          return { text: JSON.stringify({ claims }), model: "fake", usage: { inputTokens: 1, outputTokens: 1 } };
        },
      };
      const client = new ModelClient(provider, new CallBudget({ maxCallsPerRun: 1, maxCallsTotal: 1 }, "r", join(dir, "totals"), join(dir, "ledger")));
      const report = await runCheck(client, {
        targetPath, source: { directory: dir, commit: "fixture" }, runsDir: dir, workDir: dir, maxKaneRuns: limit,
      });
      const saved = JSON.parse(readFileSync(join(dir, report.runId, "check.json"), "utf8"));
      expect(saved.tested).toHaveLength(limit);
      expect(saved.notTested).toEqual(["README.md#L1", "README.md#L2"].slice(limit));
      expect(runKane).toHaveBeenCalledTimes(limit);
      expect(startApp).toHaveBeenCalledTimes(limit);
      expect(stop).toHaveBeenCalledTimes(limit);
    } finally {
      vi.mocked(startApp).mockReset();
      vi.mocked(runKane).mockReset();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("extractClaimsCached", () => {
  it("calls the model once per document and reuses the result", async () => {
    let calls = 0;
    const provider: ModelProvider = {
      name: "fake",
      async generate(_r, before) {
        before();
        calls++;
        return { text: JSON.stringify({ claims: [{ type: "behaviour", quote: "Import and export bookmarks", startLine: 1, endLine: 1, check: "c" }] }), model: "f", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const dir = mkdtempSync(join(tmpdir(), "pino-c-"));
    const client = new ModelClient(provider, new CallBudget({ maxCallsPerRun: 9, maxCallsTotal: 9 }, "r", join(dir, "t.json"), join(dir, "l.jsonl")));
    const doc = { file: "README.md", content: "- Import and export bookmarks" };
    const first = await extractClaimsCached(client, [doc], join(dir, "cache"));
    const second = await extractClaimsCached(client, [doc], join(dir, "cache"));
    expect(calls).toBe(1);
    expect(second).toEqual({ ...first, cacheHits: 1 });
    expect(cacheKey(doc)).not.toBe(cacheKey({ ...doc, content: `${doc.content}!` }));
  });
});
