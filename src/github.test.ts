import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCheck } from "./check.js";
import { copyEvidence, githubComment, kaneTranscript, stageGitHubReadme } from "./github.js";
import { CallBudget } from "./model/budget.js";
import { ModelClient } from "./model/client.js";
import type { ModelProvider } from "./model/types.js";
import { loadTarget } from "./target.js";
import { contentHash } from "./frozen.js";
import { fileURLToPath } from "node:url";

const LINKDING_TARGET = fileURLToPath(new URL("../targets/linkding.json", import.meta.url));

const BASE = "b".repeat(40);
const HEAD = "a".repeat(40);
const REPO = "owner/public-app";
const PROFILE = ".github/fibcheck.target.json";
const serverUrl = new URL("/", loadTarget(LINKDING_TARGET).repo);
const apiUrl = new URL(serverUrl);
apiUrl.hostname = "api." + serverUrl.hostname;
const readme = "# Public app\n\nClick the Edit button.\n[Linked notes](../target.json)\n";
const event = {
  repository: { full_name: REPO, private: false },
  pull_request: {
    base: { sha: BASE, repo: { full_name: REPO } },
    head: { sha: HEAD, repo: { full_name: REPO } },
  },
};
const profile = JSON.stringify({
  name: "public-app",
  repo: "placeholder",
  docs: ["some-local-file.md"],
  app: { image: "example/app", port: 9090, containerPort: 80 },
});

function fileResponse(text: string): Response {
  return Response.json({ type: "file", encoding: "base64", content: Buffer.from(text).toString("base64") });
}

describe("GitHub README check", () => {
  let directory: string;
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "fibcheck-pr-test-")); });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  function options() {
    return {
      eventName: "pull_request_target",
      apiUrl: apiUrl.href,
      serverUrl: serverUrl.href,
      targetFile: PROFILE,
      directory, maxClaims: 0, event,
    };
  }

  it("uses only the pinned head README and the trusted base profile", async () => {
    const requests: URL[] = [];
    const getFile: typeof fetch = (input, init) => {
      const url = new URL(String(input));
      requests.push(url);
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      return Promise.resolve(fileResponse(url.pathname.endsWith("README.md") ? readme : profile));
    };
    const staged = await stageGitHubReadme(options(), getFile);
    expect(requests.map((url) => [url.pathname, url.searchParams.get("ref")])).toEqual([
      [`/repos/${REPO}/contents/README.md`, HEAD],
      [`/repos/${REPO}/contents/${PROFILE}`, BASE],
    ]);
    if (!staged.source) throw new Error("Expected staged README source.");
    expect(staged.source.commit).toBe(HEAD);
    expect(readFileSync(join(staged.source.directory, "README.md"), "utf8")).toBe(readme);
    expect(loadTarget(staged.targetPath)).toMatchObject({ docs: [], app: { image: "example/app" } });

    const generate = vi.fn<ModelProvider["generate"]>((_request, attempt) => {
      attempt();
      return Promise.resolve({
        text: JSON.stringify({ claims: [{ type: "ui_flow", quote: "Click the Edit button.", startLine: 3, endLine: 3, check: "Look for Edit." }] }),
        model: "fake",
        usage: { inputTokens: 0, outputTokens: 0 },
      });
    });
    const provider: ModelProvider = { name: "fake", generate };
    const budget = new CallBudget({ maxCallsPerRun: 5, maxCallsTotal: 5 }, "test", join(directory, "totals.json"), join(directory, "ledger.jsonl"));
    const report = await runCheck(new ModelClient(provider, budget), { ...staged, workDir: join(directory, "work") });
    expect(generate).toHaveBeenCalledOnce();
    expect(generate.mock.calls[0]?.[0].prompt).toContain("Click the Edit button.");
    expect(report).toMatchObject({ commit: HEAD, documents: ["README.md"], tested: [], notTested: ["README.md#L3"] });
    expect(report.repo).toBe(new URL(REPO, options().serverUrl).href);
    const comment = githubComment({ ...report, target: "@someone", repo: "private-path", documents: ["private-path.md"] });
    expect(comment).toContain(HEAD.slice(0, 12));
    expect(comment).toContain("| Not run | 1 |");
    expect(comment).toContain("| 3 | Not run (over the claim limit) | none |");
    expect(comment).not.toMatch(/Click the Edit button|@someone|private-path/);
    expect(comment).not.toContain("For review");
  });

  it("lists lines for a person to review without calling them false", () => {
    const claim = (line: number) => ({ id: `README.md#L${line}`, type: "ui_flow" as const, quote: "q", check: "c", source: { file: "README.md", startLine: line, endLine: line } });
    const kane = { status: "failed" } as never;
    const report = {
      runId: "r", target: "t", repo: "r", commit: HEAD, startedAt: "", finishedAt: "", documents: [], claims: [], rejected: [], notTested: [],
      kaneCredits: 0, model: { calls: 0, inputTokens: 0, outputTokens: 0, cacheHits: 0 },
      tested: [
        { claim: claim(5), kane, questioning: { verdict: "unconfirmed", reason: "", followUps: [], candidateFinding: true } },
        { claim: claim(7), kane, questioning: { verdict: "worded_differently", reason: "", followUps: [], wording: { documented: "q", visible: 'Button labelled "Attack"' } } },
        { claim: claim(9), kane, questioning: { verdict: "true", reason: "", followUps: [] } },
        { claim: claim(11), kane, questioning: { verdict: "true", reason: "", followUps: [{ purpose: "reword", reason: "", kane: { status: "passed" } }] } },
      ],
    } as never;
    const comment = githubComment(report, "examples/demo/README.md");
    expect(comment).toContain("Checked `examples/demo/README.md`");
    expect(comment).toContain("- Line 5: Kane failed it twice and a control passed.");
    expect(comment).toContain('- Line 7: the behaviour held, but the app shows Button labelled "Attack".');
    expect(comment).not.toContain("Line 9");
    expect(comment).toContain("| 9 | Held | failed |");
    expect(comment).toContain("| 7 | Held, worded differently | failed |");
    expect(comment).toContain("| 11 | Held | failed, passed (reword) |");
    expect(comment.slice(comment.indexOf("For review"))).not.toMatch(/\bfalse\b|\blie\b|outdated/i);
  });

  it("rejects fork, private, untrusted event, and malformed input before making requests", async () => {
    const fetchFile = vi.fn<typeof fetch>();
    const fork = { ...event, pull_request: { ...event.pull_request, head: { sha: HEAD, repo: { full_name: "someone/fork" } } } };
    await expect(stageGitHubReadme({ ...options(), event: fork }, fetchFile)).rejects.toThrow(/same repository/);
    const privateRepo = { ...event, repository: { ...event.repository, private: true } };
    await expect(stageGitHubReadme({ ...options(), event: privateRepo }, fetchFile)).rejects.toThrow(/public GitHub/);
    await expect(stageGitHubReadme({ ...options(), eventName: "pull_request" }, fetchFile)).rejects.toThrow(/trusted-base/);
    await expect(stageGitHubReadme({ ...options(), targetFile: "../profile.json" }, fetchFile)).rejects.toThrow(/repository-relative/);
    await expect(stageGitHubReadme({ ...options(), apiUrl: serverUrl.href }, fetchFile)).rejects.toThrow(/runner URLs/);
    const unpinned = { ...event, pull_request: { ...event.pull_request, head: { ...event.pull_request.head, sha: "main" } } };
    await expect(stageGitHubReadme({ ...options(), event: unpinned }, fetchFile)).rejects.toThrow(/pinned/);
    expect(fetchFile).not.toHaveBeenCalled();
  });

  it("reads a chosen Markdown file from the head and rejects anything else", async () => {
    const requests: string[] = [];
    const getFile: typeof fetch = (input) => {
      const url = new URL(String(input));
      requests.push(url.pathname);
      return Promise.resolve(fileResponse(url.pathname.endsWith(".md") ? readme : profile));
    };
    const staged = await stageGitHubReadme({ ...options(), docsFile: "examples/demo/README.md" }, getFile);
    expect(requests[0]).toBe(`/repos/${REPO}/contents/examples/demo/README.md`);
    expect(readFileSync(join(staged.source!.directory, "README.md"), "utf8")).toBe(readme);
    for (const docsFile of ["../README.md", "docs/page.html", "/abs.md"]) {
      await expect(stageGitHubReadme({ ...options(), docsFile }, getFile)).rejects.toThrow(/repository-relative Markdown/);
    }
  });

  it("runs only reviewed frozen checks from the trusted base and lists the rest for review", async () => {
    const docs = "# Demo\n\nClick the *Edit* button.\n";
    const reviewedCheck = "Assert exactly: The page shows a button labelled 'Edit'. Expected: true.";
    const frozenEntry = (id: string, line: number, quoteText: string, reviewer: string) => {
      const label = quoteText.match(/\*(\w+)\*/)?.[1];
      const labelCheck = reviewedCheck.replace("'Edit'", `'${label}'`);
      return {
        id, type: "ui_flow", quote: quoteText, startLine: line, endLine: line, check: labelCheck,
        contentSha256: contentHash({ quote: quoteText, check: labelCheck }), reviewed: { by: reviewer, at: reviewer && "2026-11-20" },
      };
    };
    const claimsFile = JSON.stringify({ version: 1, docsFile: "examples/demo/README.md", claims: [
      frozenEntry("README.md#L3", 3, "Click the *Edit* button.", "owner"),
      frozenEntry("README.md#L9", 9, "Click the *Old* button.", "owner"),
      frozenEntry("README.md#L4", 4, "Click the *Save* button.", ""),
    ] });
    const requests: string[] = [];
    const getFile: typeof fetch = (input) => {
      const url = new URL(String(input));
      requests.push(`${url.pathname} ${url.searchParams.get("ref")}`);
      return Promise.resolve(fileResponse(url.pathname.endsWith("claims.json") ? claimsFile : url.pathname.endsWith(".md") ? docs : profile));
    };
    const staged = await stageGitHubReadme({ ...options(), docsFile: "examples/demo/README.md", claimsFile: "examples/demo/claims.json" }, getFile);
    expect(requests).toContain(`/repos/${REPO}/contents/examples/demo/claims.json ${BASE}`);
    expect(staged.frozen).toBe(true);
    expect(staged.reviewedClaims?.map(({ id, source }) => `${id} ${source.file}`)).toEqual(["README.md#L3 README.md", "README.md#L9 README.md"]);
    expect(staged.needsReview).toEqual([{ id: "README.md#L4", line: 4, why: "No one has reviewed this check yet." }]);

    const { needsReview, ...checkOptions } = staged;
    const budget = new CallBudget({ maxCallsPerRun: 1, maxCallsTotal: 1 }, "t", join(directory, "totals.json"), join(directory, "ledger.jsonl"));
    const neverCalled: ModelProvider = { name: "none", generate: () => Promise.reject(new Error("no model call expected")) };
    const report = await runCheck(new ModelClient(neverCalled, budget), { ...checkOptions, workDir: join(directory, "work"), maxKaneRuns: 0 });
    expect(report.notTested).toEqual(["README.md#L3"]);
    const comment = githubComment(report, "examples/demo/README.md", needsReview);
    expect(comment).toContain("**Needs review (not run)**");
    expect(comment).toContain("- Line 4: No one has reviewed this check yet.");
    expect(comment).toContain("- Line 9 no longer says what was reviewed, so its frozen check was not run.");
    await expect(stageGitHubReadme({ ...options(), claimsFile: "examples/demo/claims.json" }, getFile)).rejects.toThrow(/different docs file/);
  });

  it("fails clearly for a removed README or unsupported API contents", async () => {
    const missing: typeof fetch = (input) => Promise.resolve(String(input).includes("README.md") ? new Response(null, { status: 404 }) : fileResponse(profile));
    await expect(stageGitHubReadme(options(), missing)).rejects.toThrow(/README.md.*HTTP 404/);
    const invalid: typeof fetch = () => Promise.resolve(Response.json({ type: "dir" }));
    await expect(stageGitHubReadme(options(), invalid)).rejects.toThrow(/supported file contents/);
  });

  it("prints every Kane step for the public log without generated passwords, paths or line breaks", () => {
    const run = (status: string, outDir: string) => ({
      status, oneLiner: "opened the Admin app", objective: "Log in with password {{app_pass}}.\nOpen Settings.", outDir,
      steps: [{ step: 1, status: "done", remark: "type: Type Pk0123456789abcdef01234567 into Password" }, { step: 2, status: "done", remark: "click Admin in /Users/me/x\n::error::injected" }],
      observations: [{ name: "o", condition: "Admin tab inside Settings page", expectedValue: "true", extractedValue: "false" }],
    });
    const out = join(directory, "run1");
    mkdirSync(join(out, "evidence"), { recursive: true });
    writeFileSync(join(out, "evidence", "step-1.jpg"), "x");
    const report = {
      runId: "r", target: "t", repo: "r", commit: HEAD, startedAt: "", finishedAt: "", documents: [], claims: [], rejected: [], notTested: [],
      kaneCredits: 0, model: { calls: 0, inputTokens: 0, outputTokens: 0, cacheHits: 0 },
      tested: [{
        claim: { id: "README.md#L5", type: "ui_flow", quote: "Click the Admin tab.", check: "c", source: { file: "README.md", startLine: 5, endLine: 5 } },
        kane: run("passed", out),
        questioning: { verdict: "true", reason: "", followUps: [{ purpose: "reproduce", reason: "", kane: run("failed", join(directory, "missing")) }] },
      }],
    } as never;
    const log = kaneTranscript(report);
    expect(log).toContain("::group::Line 5 (true): 2 Kane run(s)");
    expect(log).toContain("Run 2 (reproduce): failed.");
    expect(log).toContain("observed Admin tab inside Settings page: expected true, saw false");
    expect(log).toContain("[secret]");
    expect(log).not.toMatch(/Pk0123|\/Users\/|^::error::/m);
    expect(log.split("\n").filter((line) => line.startsWith("::"))).toEqual(["::group::Line 5 (true): 2 Kane run(s)", "::endgroup::"]);
    const destination = join(directory, "evidence-out");
    expect(copyEvidence(report, destination)).toBe(1);
    expect(existsSync(join(destination, "line-5", "run-1-initial", "step-1.jpg"))).toBe(true);
  });
});
