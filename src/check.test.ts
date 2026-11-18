import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { startApp } from "./app/docker.js";
import { localAddressesToApp, objectiveFor, runCheck, verifyReviewedClaims, withAppUrl } from "./check.js";
import { cacheKey, extractClaimsCached } from "./claims/cache.js";
import type { Claim } from "./claims/types.js";
import { parseKaneOutput } from "./kane/parse.js";
import { runKane } from "./kane/runner.js";
import { CallBudget } from "./model/budget.js";
import { ModelClient } from "./model/client.js";
import type { ModelProvider } from "./model/types.js";
import { loadTarget, loginSecretsFromEnv, resolveTarget, runningAppVariables, targetPathFor } from "./target.js";

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

  it("selects only named running-app secrets and rejects inherited or missing values", () => {
    const login = "Sign in with {{account}} and {{password}}. Confirm {{account}}.";
    const secrets = { account: "test account", password: "disposable password", unused: "other value" };
    expect(runningAppVariables(login, secrets)).toEqual({
      account: { value: secrets.account, secret: true }, password: { value: secrets.password, secret: true },
    });
    expect(() => runningAppVariables(login, { account: secrets.account })).toThrow(/Missing login value "password".*FIBCHECK_LOGIN_PASSWORD/);
    expect(() => runningAppVariables("Use {{constructor}}.", {})).toThrow(/Missing login value "constructor"/);
    expect(runningAppVariables(undefined, secrets)).toEqual({});
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

describe("verifyReviewedClaims", () => {
  const documents = [{ file: "docs/usage.md", content: "# Usage\n\nPress n to add a new bookmark.\nOther text.\n" }];
  const base = { id: "docs/usage.md#L3", type: "ui_flow" as const, check: "Press n.", source: { file: "docs/usage.md", startLine: 9, endLine: 9 } };

  it("keeps a quote found in its document and corrects the line", () => {
    const result = verifyReviewedClaims(documents, [{ ...base, quote: "Press n to add a new bookmark." }]);
    expect(result.claims[0]?.source).toEqual({ file: "docs/usage.md", startLine: 3, endLine: 3 });
    expect(result.rejected).toEqual([]);
  });

  it("rejects quotes that are not in the document, or documents that were not read", () => {
    const result = verifyReviewedClaims(documents, [
      { ...base, quote: "Press x to delete everything." },
      { ...base, quote: "Press n to add a new bookmark.", source: { file: "docs/other.md", startLine: 1, endLine: 1 } },
    ]);
    expect(result.claims).toEqual([]);
    expect(result.rejected.map(({ why }) => why)).toEqual(["The quote was not found in the document.", "The document was not read."]);
  });
});

describe("withAppUrl and login values", () => {
  const resolved = { name: "x", repo: "r", app: { image: "i", port: 1, containerPort: 1 }, baseUrl: "http://localhost:1", resolvedEnv: {}, kaneVariables: {} };

  it("points the target at a running app and drops a trailing slash", () => {
    expect(withAppUrl(resolved, "https://bookmarks.example.org/app/").baseUrl).toBe("https://bookmarks.example.org/app");
    expect(withAppUrl(resolved, undefined).baseUrl).toBe("http://localhost:1");
  });

  it.each([
    ["bookmarks.example.org", "full address"],
    ["ftp://example.org", "http:// or https://"],
    ["https://me:secret@example.org", "must not contain a user name or password"],
  ])("rejects %s", (url, message) => {
    expect(() => withAppUrl(resolved, url)).toThrow(message);
  });

  it("reads only the login values the sentence names from FIBCHECK_LOGIN_*", () => {
    const env = { FIBCHECK_LOGIN_USER: "ada", FIBCHECK_LOGIN_PASS: "pw-1234", FIBCHECK_LOGIN_OTHER: "unused" };
    expect(loginSecretsFromEnv("Sign in as {{user}} with password {{pass}}.", env)).toEqual({ user: "ada", pass: "pw-1234" });
    expect(loginSecretsFromEnv("Sign in as {{missing}}.", env)).toEqual({});
    expect(loginSecretsFromEnv(undefined, env)).toEqual({});
  });
});

describe("localAddressesToApp", () => {
  it.each([
    ["Go to http://localhost:5230. Create a memo.", "Go to the app's start page. Create a memo."],
    ["Open http://127.0.0.1:8080/settings/general and check.", "Open the app's /settings/general page and check."],
    ["Bookmark https://example.com as a test.", "Bookmark https://example.com as a test."],
  ])("rewrites %s", (input, output) => {
    expect(localAddressesToApp(input)).toBe(output);
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

  it.each(["{{{x}}}", "{{{{y", "a}}}}", "{ {{z}} }"])("leaves no doubled braces in %s", (quote) => {
    const text = objectiveFor({ ...claim, quote, check: quote }, { login: undefined });
    expect(text).not.toMatch(/\{\{|\}\}/);
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

describe("running app login", () => {
  it.each([false, true])("keeps the login secret private and removes it when Kane fails (%s)", async (fails) => {
    const dir = mkdtempSync(join(tmpdir(), "pino-login-"));
    const stubPassword = "fake-disposable-credential";
    const login = "Sign in using password {{app_pass}}.";
    const logs: string[] = [];
    let variablesFile: string | undefined;
    vi.mocked(runKane).mockImplementation(async (options) => {
      variablesFile = options.variablesFile;
      expect(options.objective).toContain(login);
      expect(options.objective).not.toContain(stubPassword);
      if (!variablesFile) throw new Error("Expected a Kane variables file.");
      expect(statSync(variablesFile).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(variablesFile)).mode & 0o777).toBe(0o700);
      expect(JSON.parse(readFileSync(variablesFile, "utf8"))).toEqual({ app_pass: { value: stubPassword, secret: true } });
      if (fails) throw new Error("Kane stub stopped.");
      return {
        ...parseKaneOutput('{"type":"run_end","status":"passed"}', 0),
        objective: options.objective, startUrl: options.startUrl, outDir: options.outDir, evidence: [], evidenceError: null,
      };
    });
    try {
      const targetPath = join(dir, "target.json");
      const app = { image: "test", port: 1, containerPort: 2, env: { APP_PASSWORD: "{{secret:app_pass}}" } };
      writeFileSync(targetPath, JSON.stringify({ name: "t", repo: dir, app, login }));
      writeFileSync(join(dir, "README.md"), "Toggle dark mode");
      const provider: ModelProvider = {
        name: "fake",
        async generate(request, before) {
          before();
          expect(JSON.stringify(request)).not.toContain(stubPassword);
          expect(request.prompt).not.toContain("app_pass");
          const claims = [{ type: "behaviour", quote: "Toggle dark mode", startLine: 1, endLine: 1, check: "Toggle dark mode" }];
          return { text: JSON.stringify({ claims }), model: "fake", usage: { inputTokens: 0, outputTokens: 0 } };
        },
      };
      const client = new ModelClient(provider, new CallBudget({ maxCallsPerRun: 1, maxCallsTotal: 1 }, "r", join(dir, "totals"), join(dir, "ledger")));
      const result = runCheck(client, {
        targetPath, source: { directory: dir, commit: "fixture" }, runsDir: dir, workDir: dir,
        appRunning: true, appRunningSecrets: { app_pass: stubPassword }, log: (line) => logs.push(line),
      });
      if (fails) {
        await expect(result).rejects.toThrow("Kane stub stopped.");
      } else {
        const { runId } = await result;
        expect(readFileSync(join(dir, runId, "check.json"), "utf8")).not.toContain(stubPassword);
      }
      expect(runKane).toHaveBeenCalledOnce();
      expect(startApp).not.toHaveBeenCalled();
      expect(logs.join("\n")).not.toContain(stubPassword);
      if (!variablesFile) throw new Error("Expected the Kane stub to receive a variables file.");
      expect(existsSync(dirname(variablesFile))).toBe(false);
    } finally {
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
