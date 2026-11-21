import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startApp, type RunningApp } from "./app/docker.js";
import { extractClaimsCached } from "./claims/cache.js";
import { collectDocuments } from "./claims/documents.js";
import { locateQuote } from "./claims/quotes.js";
import { rankClaims } from "./claims/rank.js";
import type { Claim, RejectedClaim, SourceDocument } from "./claims/types.js";
import { runKane, type KaneRun } from "./kane/runner.js";
import { seedLinkdingTags } from "./linkding-tags.js";
import { modelDiagnoser } from "./diagnose.js";
import type { GeneralQuestioning } from "./general-loop.js";
import { questionClaim } from "./loop.js";
import type { Questioning } from "./loop-types.js";
import type { ModelClient } from "./model/client.js";
import { missingLabelAssertion } from "./frozen.js";
import { appBaseUrl, loadTarget, resolveTarget, runningAppVariables, type ResolvedTarget } from "./target.js";

export interface CheckOptions {
  targetPath: string;
  /** A trusted caller can provide documents staged from a pinned public revision. */
  source?: { directory: string; commit: string };
  /** Where run folders go (default `runs/`). */
  runsDir?: string;
  /** fibcheck's working folder for clones and caches (default `.fibcheck/`). */
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
  /**
   * Check an app that is already running at this address instead of starting Docker. Implies `appRunning`.
   * The address must be http or https and carry no user name or password.
   */
  appUrl?: string;
  /** Replaces the target's login sentence, for example for your own account on an app at `appUrl`. */
  login?: string;
  /**
   * A trusted caller can supply reviewed claims instead of model extraction. Each quote must be found in the named
   * document near its cited lines, or the claim is rejected and not tested.
   */
  reviewedClaims?: Claim[];
  /**
   * The reviewed claims are frozen: run each check exactly as reviewed, never reword it, and use only the
   * reviewed control. Claims whose quote is no longer in the document are listed as needing review.
   */
  frozen?: boolean;
  /** Let the model read failed or unreviewed Kane runs and propose rewordings, reproductions and controls (default true). */
  diagnose?: boolean;
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
  /** Testable claims from most to least specific, with the reasons for each score. Older checks lack it. */
  ranking?: { id: string; score: number; reasons: string[] }[];
  kaneCredits: number;
  /** `models` lists every model that answered in this check; older checks lack it. */
  model: { calls: number; inputTokens: number; outputTokens: number; cacheHits: number; models?: string[]; spendingLimit?: string };
  /** Document parts whose model reply could not be used. Their claims are missing from this check. */
  unusableModelOutput?: { file: string; lines: string; why: string }[];
}

/** Reads a target's docs, extracts claims and runs the selected browser checks. */
export async function runCheck(client: ModelClient, options: CheckOptions): Promise<CheckReport> {
  validateOptions(options);
  const log = options.log ?? (() => {});
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const workDir = options.workDir ?? ".fibcheck";
  const runDir = resolve(options.runsDir ?? "runs", runId);
  mkdirSync(runDir, { recursive: true });
  const loaded = loadTarget(options.targetPath);
  const target = withAppUrl(resolveTarget(options.login === undefined ? loaded : { ...loaded, login: options.login }), options.appUrl);
  const startedAt = new Date().toISOString();

  const repoDir = options.source?.directory ?? fetchRepo(target.repo, join(workDir, "repos", target.name));
  const commit = options.source?.commit ?? gitHead(repoDir);
  const documents = collectDocuments(repoDir, target.docs ?? []);
  log(`Read ${documents.length} document(s) from ${target.repo}${commit ? ` at ${commit.slice(0, 7)}` : ""}.`);

  const extraction = options.reviewedClaims
    ? verifyReviewedClaims(documents, options.reviewedClaims, options.frozen)
    : await extractClaimsCached(client, documents, join(workDir, "cache", "claims"));
  // Every claim that names a UI element must open with an exact-label assertion; a check without one is not run.
  const unlabelled = extraction.claims.flatMap((claim) => {
    const why = claim.type !== "untestable" && claim.check ? missingLabelAssertion(claim) : undefined;
    return why ? [{ claim, why }] : [];
  });
  const testable = extraction.claims.filter((c) => c.type !== "untestable" && c.check && !unlabelled.some(({ claim }) => claim === c));
  for (const { claim, why } of unlabelled) {
    extraction.rejected.push({ quote: claim.quote, file: claim.source.file, why: `Needs review: line ${claim.source.startLine}. ${why}` });
  }
  log(`Found ${extraction.claims.length} claims (${testable.length} testable), ${extraction.rejected.length} rejected quotes, ${extraction.cacheHits} document(s) from cache.`);
  if (extraction.unusable?.length) log(`The model's reply could not be used for ${extraction.unusable.length} document part(s); their claims are missing.`);

  // The most specific claims first: named controls, steps, settings and defaults are what go stale.
  const ranked = rankClaims(testable);
  const candidates = ranked.map(({ claim }) => claim);
  const selected = (options.only?.length ? candidates.filter((c) => options.only?.includes(c.id)) : candidates).slice(0, options.maxClaims ?? 5);
  const tested = await testClaims(target, selected, { runDir, runId, options, log, client });
  const testedClaims = new Set(tested.map(({ claim }) => claim.id));
  const notTested = candidates.filter((claim) => !testedClaims.has(claim.id)).map((claim) => claim.id);

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
    ...(extraction.unusable?.length ? { unusableModelOutput: extraction.unusable } : {}),
    tested,
    notTested,
    ranking: ranked.map(({ claim, score, reasons }) => ({ id: claim.id, score, reasons })),
    kaneCredits: totalKaneCredits(tested),
    model: { ...client.usage(), cacheHits: extraction.cacheHits },
  };
  writeFileSync(join(runDir, "check.json"), `${JSON.stringify(report, null, 2)}\n`);
  log(`Saved ${join(runDir, "check.json")}`);
  return report;
}

/** The most Kane runs one claim can use: initial check, one rewording, a reproduction and a control. */
export const DEFAULT_RUNS_PER_CLAIM = 4;

/** Keeps supplied claims whose quotes appear in their documents, with corrected line numbers. */
export function verifyReviewedClaims(documents: SourceDocument[], claims: Claim[], frozen = false): { claims: Claim[]; rejected: RejectedClaim[]; unusable?: { file: string; lines: string; why: string }[]; cacheHits: number } {
  const verified: Claim[] = [];
  const rejected: RejectedClaim[] = [];
  for (const claim of claims) {
    const document = documents.find(({ file }) => file === claim.source.file);
    const source = document && locateQuote(document.content, claim.quote, claim.source);
    if (source) verified.push({ ...claim, source });
    else if (frozen && document) rejected.push({ quote: claim.quote, file: claim.source.file, why: `Needs review: line ${claim.source.startLine} no longer says what was reviewed, so its frozen check was not run.` });
    else rejected.push({ quote: claim.quote, file: claim.source.file, why: document ? "The quote was not found in the document." : "The document was not read." });
  }
  return { claims: verified, rejected, cacheHits: 0 };
}

/** Points a target at an app that is already running somewhere else. */
export function withAppUrl(target: ResolvedTarget, appUrl: string | undefined): ResolvedTarget {
  if (appUrl === undefined) return target;
  return { ...target, baseUrl: appBaseUrl(appUrl) };
}

function validateOptions({ maxKaneRuns, appRunningSecrets, appRunning, appUrl }: CheckOptions): void {
  if (maxKaneRuns !== undefined && (!Number.isSafeInteger(maxKaneRuns) || maxKaneRuns < 0)) {
    throw new Error("--max-kane-runs must be a whole number.");
  }
  if (appRunningSecrets !== undefined && !appRunning && !appUrl) {
    throw new Error("appRunningSecrets requires appRunning.");
  }
}

function totalKaneCredits(tested: ClaimRun[]): number {
  return tested.reduce((sum, { kane, questioning }) => (
    sum + (kane.credits ?? 0) + (questioning?.followUps.reduce((cost, round) => cost + (round.kane.credits ?? 0), 0) ?? 0)
  ), 0);
}

/** Starts the app, runs each claim and any follow-up checks, then cleans up. */
interface TestContext {
  runDir: string;
  runId: string;
  options: CheckOptions;
  log: (line: string) => void;
  client: ModelClient;
}

async function testClaims(target: ResolvedTarget, claims: Claim[], context: TestContext): Promise<ClaimRun[]> {
  const { runDir, runId, options, log, client } = context;
  if (claims.length === 0 || options.maxKaneRuns === 0) return [];
  let app: RunningApp | undefined;
  const alreadyRunning = Boolean(options.appRunning || options.appUrl);
  const variables = alreadyRunning ? runningAppVariables(target.login, options.appRunningSecrets ?? {}) : target.kaneVariables;
  const variablesFile = writeKaneVariables(variables);
  const managedTarget = alreadyRunning ? undefined : target;
  try {
    if (managedTarget) {
      log(`Starting ${target.app?.image ?? "the app"} on port ${target.app?.port ?? "?"}...`);
      app = await startApp(managedTarget, runId);
    }
    return await runClaims(target, claims, {
      runDir, log, managedTarget, containerName: app?.containerName,
      variablesFile: variablesFile?.path, maxKaneRuns: options.maxKaneRuns, frozen: options.frozen,
      diagnose: options.diagnose === false ? undefined : modelDiagnoser(client, [...Object.values(variables).map(({ value }) => value), new URL(target.baseUrl).host]),
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
  diagnose?: GeneralQuestioning["diagnose"];
  frozen?: boolean;
}

async function runClaims(target: ResolvedTarget, claims: Claim[], session: ClaimSession): Promise<ClaimRun[]> {
  const { runDir, log, managedTarget, containerName, variablesFile } = session;
  const tested: ClaimRun[] = [];
  const startUrl = `${target.baseUrl}${target.startPath ?? "/"}`;
  // Without an explicit cap, each claim may use its full questioning budget of 4 Kane runs and no more.
  let runsRemaining = session.maxKaneRuns ?? DEFAULT_RUNS_PER_CLAIM * claims.length;
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
    }, prepareTags, canRun, session.diagnose && {
      diagnose: session.diagnose,
      objectiveFor: (check) => objectiveFor({ ...claim, check }, target),
      frozen: session.frozen,
    });
    log(`    Claim verdict: ${result.questioning.verdict}. ${result.questioning.reason}`);
    tested.push({ claim, ...result });
  }
  return tested;
}

export function writeKaneVariables(variables: ResolvedTarget["kaneVariables"]) {
  if (Object.keys(variables).length === 0) return undefined;
  const directory = mkdtempSync(join(tmpdir(), "fibcheck-kane-"));
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
  const safe = (text: string) => text.replace(/[{}]{2,}/g, (braces) => braces.split("").join(" "));
  const parts = [
    target.login,
    `The app's documentation (${claim.source.file}, line ${claim.source.startLine}) says: "${safe(claim.quote)}".`,
    safe(localAddressesToApp(claim.check ?? "")),
  ];
  return parts.filter(Boolean).join(" ");
}

/**
 * Documentation often names its own default address (for example http://localhost:5230). The test app runs
 * elsewhere and Kane already starts on it, so a local address in a check is replaced by a reference to the app.
 */
export function localAddressesToApp(check: string): string {
  return check.replace(/\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?(\/[^\s"'<>]*)?/gi, (_match, path: string | undefined) => (
    path && path !== "/" ? `the app's ${path.replace(/[.,;:]+$/, "")} page` : "the app's start page"
  ));
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
