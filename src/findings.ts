import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ClaimVerdict } from "./loop-types.js";
import { errorMessage } from "./util.js";

/**
 * One recorded finding, as kept in `index/findings.json`. Every line on a card
 * comes from these fields, so a card can never claim more than the evidence.
 */
export interface Finding {
  id: string;
  project: string;
  /** Our own project (playful tone) or a third-party project (polite tone, never "fib" or "lie"). */
  own: boolean;
  verdict: ClaimVerdict;
  quote: string;
  source: { repo: string; commit: string; file: string; line: number };
  /** The Kane screenshot shown on the card, relative to the findings file. */
  screenshot: string;
  evidence: {
    /** Screenshots of separate Kane runs that failed the documented claim. */
    failures: string[];
    /** A passing control run, if one was made. */
    control?: string;
    /** A fresh passing Kane run after the documentation fix, if one was made. */
    fixProof?: string;
    /** For a passing run: the screenshot where the behaviour held. */
    held?: string;
  };
  /** For "worded_differently": what the interface actually shows. */
  visibleWording?: string;
  /** The proven fix: the sentence a fresh Kane run passed. Lazy fixes are judged against it. */
  fix?: string;
  /** Lazy-fix attempts that were rejected (T10), as recorded in index/attacks/<id>.json. */
  lazyFixes?: { rejected: number; byKane: number };
  /** What happened to the fix in the project itself, for example a docs PR the maintainers merged. */
  upstream?: { status: "merged"; pr: string; mergedAt: string; mergeCommit: string };
  /**
   * An optional one-line joke for the card, written by a person. It may only restate recorded facts
   * (what Kane did, what the docs say, what the app shows), and never calls a third-party project a liar.
   */
  punchline?: string;
  /** Counts for the project, not percentages: findings among claims tested. */
  score: { findings: number; claims: number };
}

export function readFindingsFile(path: string): Finding[] {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Could not read the findings file ${path}: ${errorMessage(error)}`);
  }
  if (!Array.isArray(value)) throw new Error(`Could not read the findings file ${path}: expected a list of findings.`);
  return value as Finding[];
}

export function writeFindingsFile(path: string, findings: Finding[]): void {
  writeFileSync(path, `${JSON.stringify(findings, null, 2)}\n`);
}

/** Reads and checks the findings file; every referenced screenshot must exist. */
export function loadFindings(path: string): Finding[] {
  const findings = readFindingsFile(path);
  for (const finding of findings) {
    for (const file of evidenceFiles(finding)) {
      if (!existsSync(join(dirname(path), file))) throw new Error(`Finding ${finding.id} refers to a missing file: ${file}`);
    }
    if ((finding.verdict === "false" || finding.verdict === "outdated") && (finding.evidence.failures.length < 2 || !finding.evidence.control)) {
      throw new Error(`Finding ${finding.id} is ${finding.verdict} without two recorded failures and a control.`);
    }
  }
  return findings;
}

export function evidenceFiles(finding: Finding): string[] {
  const { failures, control, fixProof, held } = finding.evidence;
  return [finding.screenshot, ...failures, control, fixProof, held].filter((file): file is string => Boolean(file));
}
