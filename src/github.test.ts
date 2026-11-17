import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCheck } from "./check.js";
import { githubComment, stageGitHubReadme } from "./github.js";
import { CallBudget } from "./model/budget.js";
import { ModelClient } from "./model/client.js";
import type { ModelProvider } from "./model/types.js";
import { loadTarget } from "./target.js";

const BASE = "b".repeat(40);
const HEAD = "a".repeat(40);
const REPO = "owner/public-app";
const PROFILE = ".github/fibcheck.target.json";
const serverUrl = new URL("/", loadTarget("targets/linkding.json").repo);
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
    expect(comment).not.toMatch(/Click the Edit button|@someone|private-path/);
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

  it("fails clearly for a removed README or unsupported API contents", async () => {
    const missing: typeof fetch = (input) => Promise.resolve(String(input).includes("README.md") ? new Response(null, { status: 404 }) : fileResponse(profile));
    await expect(stageGitHubReadme(options(), missing)).rejects.toThrow(/README.md.*HTTP 404/);
    const invalid: typeof fetch = () => Promise.resolve(Response.json({ type: "dir" }));
    await expect(stageGitHubReadme(options(), invalid)).rejects.toThrow(/supported file contents/);
  });
});
