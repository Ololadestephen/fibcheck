import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import type { Finding } from "./card.js";
import type { CheckReport, ClaimRun } from "./check.js";
import type { KaneRun } from "./kane/runner.js";

export interface ConfirmOptions {
  /** A saved check.json from `fibcheck check`, with its claims/ folder beside it. */
  checkPath: string;
  claimId: string;
  /** The person's decision after reading the screenshots. */
  verdict: "false" | "outdated";
  /** The findings file to add to. Created if missing; screenshots go to evidence/ beside it. */
  findingsPath: string;
  /** The corrected sentence a fresh Kane run passed. `attack` needs it. */
  fix?: string;
  project?: string;
  /** The checker's own project, which gets the playful card tone. */
  own?: boolean;
  id?: string;
}

/**
 * Turns a candidate finding from a saved check into an entry in a findings file, after a person has read the
 * evidence. It copies Kane's screenshots of the two failing runs and the passing control, unchanged, and
 * refuses anything short of that, so `card` and `attack` only ever work from a backed finding.
 */
export function confirmFinding(options: ConfirmOptions): Finding {
  if (options.verdict !== "false" && options.verdict !== "outdated") throw new Error("A confirmed finding is false or outdated.");
  const report = readJson<CheckReport>(options.checkPath, "check");
  const { tested, failures, control } = backedCandidate(report, options);
  const findings = existsSync(options.findingsPath) ? readJson<Finding[]>(options.findingsPath, "findings") : [];
  const { claim } = tested;
  const project = options.project ?? report.target;
  const id = options.id ?? `${slug(project)}-${slug(basename(claim.source.file, extname(claim.source.file)))}-l${claim.source.startLine}`;
  if (findings.some((finding) => finding.id === id)) throw new Error(`${options.findingsPath} already has a finding called ${id}.`);

  const checkDir = dirname(options.checkPath);
  mkdirSync(join(dirname(options.findingsPath), "evidence"), { recursive: true });
  const copy = (kane: KaneRun, name: string, pick: "failed" | "last") => {
    const source = screenshotOf(checkDir, kane, pick);
    const file = `evidence/${id}-${name}${extname(source)}`;
    copyFileSync(source, join(dirname(options.findingsPath), file));
    return file;
  };
  const failureFiles = [copy(failures[0]!, "run1", "failed"), copy(failures[1]!, "run2", "failed")];
  const finding: Finding = {
    id, project, own: options.own ?? false, verdict: options.verdict, quote: claim.quote,
    source: { repo: report.repo, commit: report.commit ?? "", file: claim.source.file, line: claim.source.startLine },
    screenshot: failureFiles[0]!,
    evidence: { failures: failureFiles, control: copy(control, "control", "last") },
    score: { findings: 1, claims: report.tested.length },
    ...(options.fix ? { fix: options.fix } : {}),
  };
  writeFileSync(options.findingsPath, `${JSON.stringify([...findings, finding], null, 2)}\n`);
  return finding;
}

/** The tested claim, if it is a candidate finding backed by two failed runs and a passing control. */
function backedCandidate(report: CheckReport, { claimId, checkPath }: ConfirmOptions): { tested: ClaimRun; failures: KaneRun[]; control: KaneRun } {
  const tested = report.tested.find(({ claim }) => claim.id === claimId);
  if (!tested) throw new Error(`${claimId} was not tested in ${checkPath}.`);
  const verdict = tested.questioning?.verdict;
  if (!tested.questioning?.candidateFinding && verdict !== "false" && verdict !== "outdated") {
    throw new Error(`${claimId} is not a candidate finding in this check, so there is nothing to confirm.`);
  }
  const { failures, control } = backingRuns(tested);
  if (failures.length < 2 || !control) {
    throw new Error(`${claimId} needs two separate failed Kane runs and a passing control before it can be confirmed.`);
  }
  return { tested, failures, control };
}

function readJson<T>(path: string, what: string): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (error) {
    throw new Error(`Could not read the ${what} file ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The failed runs of the documented check (the first run and its reproductions) and the passing control. */
function backingRuns({ kane, questioning }: ClaimRun): { failures: KaneRun[]; control?: KaneRun } {
  const followUps = questioning?.followUps ?? [];
  const failures = [kane, ...followUps.filter(({ purpose }) => purpose === "retry").map((followUp) => followUp.kane)]
    .filter((run) => run.status === "failed");
  const control = followUps.find(({ purpose, kane: run }) => purpose === "control" && run.status === "passed")?.kane;
  return { failures, control };
}

/** Kane's screenshot for a run, from the claims/ folder saved beside the check: the failed step, or the last step. */
function screenshotOf(checkDir: string, kane: KaneRun, pick: "failed" | "last"): string {
  const shots = kane.evidence.filter(({ screenshot }) => screenshot);
  const step = (pick === "failed" ? shots.filter(({ status }) => status === "failed").at(-1) : undefined) ?? shots.at(-1);
  if (!step?.screenshot) throw new Error(`Kane saved no screenshot for the run in ${basename(kane.outDir)}.`);
  const path = join(checkDir, "claims", basename(kane.outDir), "evidence", step.screenshot);
  if (!existsSync(path)) throw new Error(`Kane's screenshot is missing: ${path}`);
  return path;
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
