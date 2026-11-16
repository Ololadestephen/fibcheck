import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { startApp, type RunningApp } from "./app/docker.js";
import { extractClaimsCached } from "./claims/cache.js";
import { collectDocuments } from "./claims/documents.js";
import type { Claim, RejectedClaim } from "./claims/types.js";
import { runKane, type KaneRun } from "./kane/runner.js";
import type { ModelClient } from "./model/client.js";
import { loadTarget, resolveTarget, type ResolvedTarget } from "./target.js";

export interface CheckOptions {
  targetPath: string;
  /** Where run folders go (default `runs/`). */
  runsDir?: string;
  /** Pinocchio's working folder for clones and caches (default `.pinocchio/`). */
  workDir?: string;
  /** Test at most this many claims (Kane credits are limited). */
  maxClaims?: number;
  /** Test only these claim ids. */
  only?: string[];
  /** Use an app already running at the target's port instead of starting Docker. */
  appRunning?: boolean;
  log?: (line: string) => void;
}

export interface ClaimRun {
  claim: Claim;
  kane: KaneRun;
}

export interface CheckReport {
  runId: string;
  target: string;
  repo: string;
  commit: string | null;
  startedAt: string;
  finishedAt: string;
  documents: string[];
  claims: Claim[];
  rejected: RejectedClaim[];
  tested: ClaimRun[];
  /** Testable claims not run in this check (over the limit or not selected). */
  notTested: string[];
  kaneCredits: number;
  model: { calls: number; inputTokens: number; outputTokens: number; cacheHits: number };
}

/** Reads a target's docs, extracts claims and runs each testable claim through Kane. No verdicts yet (T4). */
export async function runCheck(client: ModelClient, options: CheckOptions): Promise<CheckReport> {
  const log = options.log ?? (() => {});
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const workDir = options.workDir ?? ".pinocchio";
  const runDir = resolve(options.runsDir ?? "runs", runId);
  mkdirSync(runDir, { recursive: true });
  const target = resolveTarget(loadTarget(options.targetPath));
  const startedAt = new Date().toISOString();

  const repoDir = fetchRepo(target.repo, join(workDir, "repos", target.name));
  const commit = gitHead(repoDir);
  const documents = collectDocuments(repoDir, target.docs ?? []);
  log(`Read ${documents.length} document(s) from ${target.repo}${commit ? ` at ${commit.slice(0, 7)}` : ""}.`);

  const extraction = await extractClaimsCached(client, documents, join(workDir, "cache", "claims"));
  const testable = extraction.claims.filter((c) => c.type !== "untestable" && c.check);
  log(`Found ${extraction.claims.length} claims (${testable.length} testable), ${extraction.rejected.length} rejected quotes, ${extraction.cacheHits} document(s) from cache.`);

  const selected = (options.only?.length ? testable.filter((c) => options.only?.includes(c.id)) : testable).slice(0, options.maxClaims ?? 5);
  const notTested = testable.filter((c) => !selected.includes(c)).map((c) => c.id);

  const tested: ClaimRun[] = [];
  let app: RunningApp | undefined;
  const variablesFile = join(runDir, "kane-variables.json");
  try {
    if (selected.length > 0 && !options.appRunning) {
      log(`Starting ${target.app.image} on port ${target.app.port}...`);
      app = await startApp(target, runId);
    }
    writeFileSync(variablesFile, JSON.stringify(target.kaneVariables), { mode: 0o600 });
    chmodSync(variablesFile, 0o600);
    for (const [index, claim] of selected.entries()) {
      log(`[${index + 1}/${selected.length}] ${claim.id}: "${claim.quote}"`);
      const kane = await runKane({
        objective: objectiveFor(claim, target),
        startUrl: `${target.baseUrl}${target.startPath ?? "/"}`,
        outDir: join(runDir, "claims", safeName(claim.id)),
        variablesFile: Object.keys(target.kaneVariables).length ? variablesFile : undefined,
      });
      log(`    Kane: ${kane.status} (${kane.credits?.toFixed(1) ?? "?"} credits) ${kane.oneLiner}`);
      tested.push({ claim, kane });
    }
  } finally {
    rmSync(variablesFile, { force: true });
    if (app) await app.stop();
  }

  const report: CheckReport = {
    runId,
    target: target.name,
    repo: target.repo,
    commit,
    startedAt,
    finishedAt: new Date().toISOString(),
    documents: documents.map((d) => d.file),
    claims: extraction.claims,
    rejected: extraction.rejected,
    tested,
    notTested,
    kaneCredits: tested.reduce((sum, t) => sum + (t.kane.credits ?? 0), 0),
    model: { ...client.usage(), cacheHits: extraction.cacheHits },
  };
  writeFileSync(join(runDir, "check.json"), `${JSON.stringify(report, null, 2)}\n`);
  log(`Saved ${join(runDir, "check.json")}`);
  return report;
}

/**
 * The flow Kane runs for one claim: the login sentence, the documented claim
 * as context, and the check. `{{` in quoted text is broken up so Kane does not
 * read it as a variable.
 */
export function objectiveFor(claim: Claim, target: Pick<ResolvedTarget, "login">): string {
  const safe = (text: string) => text.replace(/\{\{/g, "{ {").replace(/\}\}/g, "} }");
  const parts = [
    target.login,
    `The app's documentation (${claim.source.file}, line ${claim.source.startLine}) says: "${safe(claim.quote)}".`,
    safe(claim.check ?? ""),
  ];
  return parts.filter(Boolean).join(" ");
}

function fetchRepo(repo: string, cloneDir: string): string {
  if (existsSync(repo)) return repo;
  if (!existsSync(join(cloneDir, ".git"))) {
    mkdirSync(cloneDir, { recursive: true });
    execFileSync("git", ["clone", "--depth", "1", "--quiet", repo, cloneDir], { stdio: ["ignore", "ignore", "pipe"] });
  }
  return cloneDir;
}

function gitHead(dir: string): string | null {
  try {
    return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function safeName(id: string): string {
  return id.replace(/[^a-zA-Z0-9_.-]+/g, "_");
}
