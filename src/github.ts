import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckOptions, CheckReport } from "./check.js";
import { countResults } from "./report/report.js";
import { loadTarget } from "./target.js";

interface PullRequestEvent {
  repository?: { full_name?: string; private?: boolean };
  pull_request?: {
    head?: { sha?: string; repo?: { full_name?: string } };
    base?: { sha?: string; repo?: { full_name?: string } };
  };
}

interface GitHubSource {
  event: unknown;
  eventName: string;
  apiUrl: string;
  serverUrl: string;
  targetFile: string;
  /** The Markdown file to check, read from the pull request head. Defaults to the root README. */
  docsFile?: string;
  directory: string;
  maxClaims: number;
}

const COMMIT = /^[0-9a-f]{40}$/i;

export async function stageGitHubReadme(input: GitHubSource, fetchFile: typeof fetch = fetch): Promise<CheckOptions> {
  const { repository, head, base } = publicPullRequest(input.eventName, input.event);
  const api = githubUrl(input.apiUrl, "api.github.com");
  const server = githubUrl(input.serverUrl, "github.com");
  const targetFile = repositoryPath(input.targetFile, ".json", "The target must be a repository-relative JSON file in the trusted base commit.");
  const docsFile = repositoryPath(input.docsFile ?? "README.md", ".md", "The docs file must be a repository-relative Markdown file.");
  if (!Number.isSafeInteger(input.maxClaims) || input.maxClaims < 0) {
    throw new Error("max-claims must be a nonnegative whole number.");
  }

  const [readme, profile] = await Promise.all([
    publicFile(api, repository, docsFile, head, fetchFile),
    publicFile(api, repository, targetFile, base, fetchFile),
  ]);
  const directory = join(input.directory, "source");
  mkdirSync(directory);
  writeFileSync(join(directory, "README.md"), readme, { flag: "wx" });
  const targetPath = join(input.directory, "target.json");
  writeFileSync(targetPath, profile, { flag: "wx", mode: 0o600 });
  const target = loadTarget(targetPath);
  writeFileSync(targetPath, JSON.stringify({
    ...target,
    repo: new URL(repository, server).href,
    docs: [],
  }));

  return {
    targetPath,
    source: { directory, commit: head },
    runsDir: join(input.directory, "runs"),
    maxClaims: input.maxClaims,
  };
}

/** The pull request comment: counts, plus the lines a person should review. Never calls a line false on its own. */
export function githubComment(report: CheckReport, docsFile = "README.md"): string {
  if (!report.commit || !COMMIT.test(report.commit)) throw new Error("A pinned commit is required for a pull request report.");
  const counts = countResults(report);
  const entries = [
    ["Claims tested", counts.tested],
    ["True", counts.verdicts.true],
    ["False", counts.verdicts.false],
    ["Outdated", counts.verdicts.outdated],
    ["Unconfirmed", counts.verdicts.unconfirmed],
    ["Untestable", counts.untestable],
    ["Not run", counts.skipped],
  ];
  if (counts.withoutVerdict > 0) entries.push(["Without verdict", counts.withoutVerdict]);
  const review = report.tested.flatMap(({ claim, questioning }) => {
    if (questioning?.candidateFinding) return [`- Line ${claim.source.startLine}: Kane failed it twice and a control passed. A person should read the evidence before changing it.`];
    if (questioning?.wording) return [`- Line ${claim.source.startLine}: the behaviour held, but the app shows ${questioning.wording.visible}.`];
    return [];
  });
  return [
    "### fibcheck docs check",
    "",
    `Checked \`${docsFile}\` at revision \`${report.commit.slice(0, 12)}\`.`,
    "",
    "| Result | Count |",
    "| --- | ---: |",
    ...entries.map(([label, count]) => `| ${label} | ${count} |`),
    "",
    `Initial Kane runs recorded ${counts.passed} passed, ${counts.failed} failed, ${counts.error} errors, and ${counts.cancelled} cancelled.`,
    ...(review.length ? ["", "**For review**", "", ...review] : []),
  ].join("\n");
}

function publicPullRequest(eventName: string, raw: unknown): { repository: string; head: string; base: string } {
  if (eventName !== "pull_request_target") throw new Error("Use the trusted-base pull_request_target workflow.");
  const event = raw as PullRequestEvent | null;
  const repository = event?.repository?.full_name;
  const pr = event?.pull_request;
  if (typeof repository !== "string" || !/^[\w-]+\/[\w.-]+$/.test(repository) || event?.repository?.private !== false) {
    throw new Error("fibcheck requires a public GitHub repository.");
  }
  if (pr?.head?.repo?.full_name !== repository || pr.base?.repo?.full_name !== repository) {
    throw new Error("fibcheck requires a pull request from a branch in the same repository.");
  }
  const { head, base } = pr;
  if (typeof head.sha !== "string" || typeof base.sha !== "string" || !COMMIT.test(head.sha) || !COMMIT.test(base.sha)) {
    throw new Error("The pull request event must provide pinned head and base commits.");
  }
  return { repository, head: head.sha, base: base.sha };
}

function githubUrl(value: string, host: string): URL {
  if (!URL.canParse(value)) throw new Error("GitHub runner URLs are required.");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.host !== host || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("The pull request check requires GitHub.com runner URLs.");
  }
  return url;
}

function repositoryPath(value: string, extension: string, problem: string): string {
  const parts = value.split("/");
  if (!value.endsWith(extension) || parts.some((part) => !/^[\w.-]+$/.test(part) || part === "." || part === "..")) {
    throw new Error(problem);
  }
  return parts.map(encodeURIComponent).join("/");
}

async function publicFile(api: URL, repo: string, path: string, revision: string, request: typeof fetch): Promise<string> {
  const url = new URL(`repos/${repo}/contents/${path}`, api);
  url.searchParams.set("ref", revision);
  const response = await request(url, {
    headers: { Accept: "application/vnd.github+json" },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`GitHub could not read ${path} at the selected revision (HTTP ${response.status}).`);
  const file = await response.json() as { type?: string; encoding?: string; content?: string };
  if (file.type !== "file" || file.encoding !== "base64" || typeof file.content !== "string" || !/^[A-Za-z0-9+/=\n\r]+$/.test(file.content)) {
    throw new Error(`GitHub did not return supported file contents for ${path}.`);
  }
  return Buffer.from(file.content, "base64").toString("utf8");
}
