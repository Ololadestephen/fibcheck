import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startApp, type RunningApp } from "./app/docker.js";
import { extractClaimsCached } from "./claims/cache.js";
import { collectDocuments } from "./claims/documents.js";
import type { Claim, RejectedClaim } from "./claims/types.js";
import { runKane, type KaneRun } from "./kane/runner.js";
import { seedLinkdingTags } from "./linkding-tags.js";
import { questionClaim } from "./loop.js";
import type { Questioning } from "./loop-types.js";
import type { ModelClient } from "./model/client.js";
import { loadTarget, resolveTarget, runningAppVariables, type ResolvedTarget } from "./target.js";

export interface CheckOptions {
  targetPath: string;
  /** A trusted caller can provide documents staged from a pinned public revision. */
  source?: { directory: string; commit: string };
  /** Where run folders go (default `runs/`). */
  runsDir?: string;
  /** Pinocchio's working folder for clones and caches (default `.pinocchio/`). */
  workDir?: string;
  /** Test at most this many claims (Kane credits are limited). */
  maxClaims?: number;
  /** Total Kane calls for this check, including retries and controls. */
  maxKaneRuns?: number;
  /** Test only these claim ids. */
  only?: string[];
  /** Use an app already running at the target's port instead of starting Docker. */
  appRunning?: boolean;
  /** A trusted caller supplies login variables for an already-running disposable app. */
  appRunningSecrets?: Readonly<Record<string, string>>;
  log?: (line: string) => void;
}

export interface ClaimRun {
  claim: Claim;
  kane: KaneRun;
  /** Present on checks written after the questioning loop was added. */
  questioning?: Questioning;
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

/** Reads a target's docs, extracts claims and runs the selected browser checks. */
export async function runCheck(client: ModelClient, options: CheckOptions): Promise<CheckReport> {
  validateOptions(options);
  const log = options.log ?? (() => {});
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const workDir = options.workDir ?? ".pinocchio";
  const runDir = resolve(options.runsDir ?? "runs", runId);
  mkdirSync(runDir, { recursive: true });
  const target = resolveTarget(loadTarget(options.targetPath));
  const startedAt = new Date().toISOString();

  const repoDir = options.source?.directory ?? fetchRepo(target.repo, join(workDir, "repos", target.name));
  const commit = options.source?.commit ?? gitHead(repoDir);
  const documents = collectDocuments(repoDir, target.docs ?? []);
  log(`Read ${documents.length} document(s) from ${target.repo}${commit ? ` at ${commit.slice(0, 7)}` : ""}.`);

  const extraction = await extractClaimsCached(client, documents, join(workDir, "cache", "claims"));
  const testable = extraction.claims.filter((c) => c.type !== "untestable" && c.check);
  log(`Found ${extraction.claims.length} claims (${testable.length} testable), ${extraction.rejected.length} rejected quotes, ${extraction.cacheHits} document(s) from cache.`);

  const selected = (options.only?.length ? testable.filter((c) => options.only?.includes(c.id)) : testable).slice(0, options.maxClaims ?? 5);
  const tested = await testClaims(target, selected, runDir, runId, options, log);
  const testedClaims = new Set(tested.map(({ claim }) => claim.id));
  const notTested = testable.filter((claim) => !testedClaims.has(claim.id)).map((claim) => claim.id);

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
    kaneCredits: totalKaneCredits(tested),
    model: { ...client.usage(), cacheHits: extraction.cacheHits },
  };
  writeFileSync(join(runDir, "check.json"), `${JSON.stringify(report, null, 2)}\n`);
  log(`Saved ${join(runDir, "check.json")}`);
  return report;
}

function validateOptions({ maxKaneRuns, appRunningSecrets, appRunning }: CheckOptions): void {
  if (maxKaneRuns !== undefined && (!Number.isSafeInteger(maxKaneRuns) || maxKaneRuns < 0)) {
    throw new Error("--max-kane-runs must be a whole number.");
  }
  if (appRunningSecrets !== undefined && !appRunning) {
    throw new Error("appRunningSecrets requires appRunning.");
  }
}

function totalKaneCredits(tested: ClaimRun[]): number {
  return tested.reduce((sum, { kane, questioning }) => (
    sum + (kane.credits ?? 0) + (questioning?.followUps.reduce((cost, round) => cost + (round.kane.credits ?? 0), 0) ?? 0)
  ), 0);
}

/** Starts the app, runs each claim and any follow-up checks, then cleans up. */
async function testClaims(target: ResolvedTarget, claims: Claim[], runDir: string, runId: string, options: CheckOptions, log: (line: string) => void): Promise<ClaimRun[]> {
  if (claims.length === 0 || options.maxKaneRuns === 0) return [];
  let app: RunningApp | undefined;
  const variables = options.appRunning ? runningAppVariables(target.login, options.appRunningSecrets ?? {}) : target.kaneVariables;
  const variablesFile = writeKaneVariables(variables);
  const managedTarget = options.appRunning ? undefined : target;
  try {
    if (managedTarget) {
      log(`Starting ${target.app.image} on port ${target.app.port}...`);
      app = await startApp(managedTarget, runId);
    }
    return await runClaims(target, claims, {
      runDir, log, managedTarget, containerName: app?.containerName,
      variablesFile: variablesFile?.path, maxKaneRuns: options.maxKaneRuns,
    });
  } finally {
    try {
      variablesFile?.remove();
    } finally {
      await app?.stop();
    }
  }
}

interface ClaimSession {
  runDir: string;
  log: (line: string) => void;
  managedTarget?: ResolvedTarget;
  containerName?: string;
  variablesFile?: string;
  maxKaneRuns?: number;
}

async function runClaims(target: ResolvedTarget, claims: Claim[], session: ClaimSession): Promise<ClaimRun[]> {
  const { runDir, log, managedTarget, containerName, variablesFile } = session;
  const tested: ClaimRun[] = [];
  const startUrl = `${target.baseUrl}${target.startPath ?? "/"}`;
  let runsRemaining = session.maxKaneRuns ?? Infinity;
  const canRun = () => runsRemaining > 0;
  let tagSetup: Promise<void> | undefined;
  const prepareTags = containerName ? () => (tagSetup ??= seedLinkdingTags(containerName)) : undefined;
  for (const [index, claim] of claims.entries()) {
    if (!canRun()) {
      log("Kane run limit reached. Remaining claims were not tested.");
      break;
    }
    log(`[${index + 1}/${claims.length}] ${claim.id}: "${claim.quote}"`);
    const folder = safeName(claim.id);
    const result = await questionClaim(claim, managedTarget, objectiveFor(claim, target), async (purpose, objective, assertionMode) => {
      runsRemaining--;
      const outDir = join(runDir, "claims", purpose === "initial" ? folder : `${folder}--${purpose}`);
      const kane = await runKane({ objective, startUrl, outDir, assertionMode, variablesFile });
      log(`    Kane ${purpose}: ${kane.status} (${kane.credits?.toFixed(1) ?? "?"} credits) ${kane.oneLiner}`);
      return kane;
    }, prepareTags, canRun);
    log(`    Claim verdict: ${result.questioning.verdict}. ${result.questioning.reason}`);
    tested.push({ claim, ...result });
  }
  return tested;
}

function writeKaneVariables(variables: ResolvedTarget["kaneVariables"]) {
  if (Object.keys(variables).length === 0) return undefined;
  const directory = mkdtempSync(join(tmpdir(), "pinocchio-kane-"));
  const path = join(directory, "variables.json");
  const remove = () => rmSync(directory, { recursive: true, force: true });
  try {
    writeFileSync(path, JSON.stringify(variables), { flag: "wx", mode: 0o600 });
  } catch (error) {
    remove();
    throw error;
  }
  return { path, remove };
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
