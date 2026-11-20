import { rankClaim } from "./claims/rank.js";
import type { Claim } from "./claims/types.js";
import type { KaneRun } from "./kane/runner.js";
import type { Diagnosis } from "./diagnose.js";
import type { ModelClient } from "./model/client.js";

/**
 * T10, lazy-fix rejection. Before a docs fix is offered, an attacker proposes
 * the shortcuts a hurried editor might take: delete the line, make it vague,
 * hedge it, or swap in a plausible but wrong detail. Each must be rejected.
 * Deletions, vaguer and hedged lines are rejected by fixed rules; a plausible
 * wrong detail is only rejected when Kane fails it in the real app.
 */
export const LAZY_KINDS = ["delete", "vague", "hedge", "wrong"] as const;
export type LazyKind = (typeof LAZY_KINDS)[number];

export interface LazyFix {
  kind: LazyKind;
  /** The replacement sentence. Empty for a deletion. */
  text: string;
  /** For a plausible wrong detail: the browser check Kane runs against it. */
  check?: string;
}

export type AttemptOutcome = "rejected_by_rule" | "rejected_by_kane" | "not_rejected" | "inconclusive";

export interface AttemptResult extends LazyFix {
  outcome: AttemptOutcome;
  reason: string;
  /** Kane's result folder and one-line summary, when Kane ran. */
  kane?: { outDir: string; status: string; oneLiner: string };
}

export interface AttackInput {
  /** The original documentation sentence that was confirmed false or outdated. */
  original: string;
  /** The proven fix: the sentence a fresh Kane run passed. */
  fix: string;
  file: string;
}

export const ATTACK_SYSTEM = `You play a hurried documentation editor who wants a failing docs check to stop failing without doing the real work. You get a documentation sentence that a browser test proved wrong, and the correct replacement that the test proved right.
Write three lazy replacements for the wrong sentence:
- vague: keeps the topic but drops the specific place, control or value, so there is nothing precise left to check.
- hedge: keeps the wrong detail but softens it with words such as "may", "usually" or "in some setups".
- wrong: a confident, specific and plausible replacement that names a different place, control or value from the correct one, the kind of guess an editor makes without opening the app. It must not match the correct replacement.
For the wrong one, also write "check": browser actions and explicit assertions that test exactly what the wrong sentence says. Begin with a separate assertion that the exact place and control it names exist (for example "Assert exactly: The header shows a menu at the bottom center. Expected: true."), and say not to use any other menu, page or route to reach the result. Do not tell the browser to open a web address; it starts on the app.
Reply as JSON.`;

const ATTACK_SCHEMA = {
  type: "object",
  properties: {
    vague: { type: "string" },
    hedge: { type: "string" },
    wrong: { type: "string" },
    check: { type: "string" },
  },
  required: ["vague", "hedge", "wrong", "check"],
} as const;

/** Asks the model for the lazy fixes; a deletion is always added without the model. */
export async function proposeLazyFixes(client: ModelClient, input: AttackInput): Promise<LazyFix[]> {
  const { value } = await client.generateJson(
    {
      purpose: "attack-lazy-fixes",
      system: ATTACK_SYSTEM,
      prompt: JSON.stringify({ file: input.file, wrong_sentence: input.original, correct_replacement: input.fix }, null, 2),
      jsonSchema: ATTACK_SCHEMA as unknown as Record<string, unknown>,
    },
    parseLazyFixes,
  );
  return [{ kind: "delete", text: "" }, ...value];
}

export function parseLazyFixes(value: unknown): LazyFix[] {
  const record = value as Record<string, unknown> | null;
  const text = (key: string) => {
    const field = record?.[key];
    if (typeof field !== "string" || !field.trim()) throw new Error(`The attack reply has no ${key}.`);
    return field.trim();
  };
  return [
    { kind: "vague", text: text("vague") },
    { kind: "hedge", text: text("hedge") },
    { kind: "wrong", text: text("wrong"), check: text("check") },
  ];
}

const HEDGES = /\b(may|might|usually|typically|sometimes|in some (?:setups|cases|versions)|depending on|possibly|often|should be able to)\b/i;

/**
 * The concrete details a reader can check: positions, numbers, quoted or emphasised names, and capitalised
 * interface words after the first word.
 */
export function detailCount(text: string): number {
  const positions = text.match(/\b(top|bottom|left|right|upper|lower|first|last|sidebar|header|footer)\b/gi)?.length ?? 0;
  const numbers = text.match(/\b\d+(\.\d+)?\b/g)?.length ?? 0;
  const named = text.match(/`[^`]+`|\*[^*]+\*|"[^"]+"|“[^”]+”/g)?.length ?? 0;
  const capitalised = text.split(/\s+/).slice(1).filter((word) => /^[A-Z][a-z]+/.test(word)).length;
  return positions + numbers + named + capitalised;
}

/** How specific a sentence is, with the same scoring that ranks claims. */
export function specificity(text: string): number {
  const claim: Claim = { id: "x", type: "ui_flow", quote: text, source: { file: "x", startLine: 1, endLine: 1 } };
  return rankClaim(claim).score;
}

/**
 * Applies the fixed rules. Returns a result for attempts the rules reject, or
 * undefined when only Kane can decide (a specific, unhedged replacement).
 */
export function judgeByRule(attempt: LazyFix, input: AttackInput): AttemptResult | undefined {
  if (!attempt.text.trim()) {
    return { ...attempt, outcome: "rejected_by_rule", reason: "Deleting the line hides the problem: readers lose the instruction and nothing is left to check." };
  }
  if (normalise(attempt.text) === normalise(input.fix)) {
    return { ...attempt, outcome: "not_rejected", reason: "This is the proven fix itself, not a lazy one." };
  }
  if (HEDGES.test(attempt.text) && !HEDGES.test(input.fix)) {
    return { ...attempt, outcome: "rejected_by_rule", reason: `Hedging ("${attempt.text.match(HEDGES)?.[0]}") softens a wrong detail instead of correcting it.` };
  }
  const attemptScore = specificity(attempt.text);
  const fixScore = specificity(input.fix);
  const attemptDetails = detailCount(attempt.text);
  const fixDetails = detailCount(input.fix);
  if (attempt.kind !== "wrong" && (attemptScore < fixScore || attemptDetails < fixDetails)) {
    return {
      ...attempt, outcome: "rejected_by_rule",
      reason: `Less specific than the proven fix (${attemptDetails} checkable details against ${fixDetails}; specificity ${attemptScore} against ${fixScore}), so it hides the detail instead of fixing it.`,
    };
  }
  return undefined;
}

/**
 * Turns Kane's run of a plausible wrong replacement into a judgement. Kane decides pass or fail; the
 * model's reading only decides whether the run tested the attempt's own place and control. A failure for
 * another reason (sign-in, the wrong page) or a pass through a different route is inconclusive, never a
 * rejection and never an acceptance.
 */
export function judgeByKane(attempt: LazyFix, kane: Pick<KaneRun, "status" | "oneLiner" | "outDir">, reading?: Pick<Diagnosis, "cause" | "exercisedClaim" | "reason">): AttemptResult {
  const record = { outDir: kane.outDir, status: kane.status, oneLiner: kane.oneLiner };
  if (kane.status !== "failed" && kane.status !== "passed") return { ...attempt, outcome: "inconclusive", reason: `Kane did not finish (${kane.status}).`, kane: record };
  if (!reading) return { ...attempt, outcome: "inconclusive", reason: "The run was not read, so it is not known whether Kane tested this attempt's own claim.", kane: record };
  if (kane.status === "failed") {
    if (reading.cause === "claim_contradicted" && reading.exercisedClaim) {
      return { ...attempt, outcome: "rejected_by_kane", reason: `Kane failed it in the app: ${kane.oneLiner}`, kane: record };
    }
    return { ...attempt, outcome: "inconclusive", reason: `Kane failed, but not on this attempt's own claim: ${reading.reason}`, kane: record };
  }
  if (reading.exercisedClaim) return { ...attempt, outcome: "not_rejected", reason: "Kane passed it in the place it names, so a person must review whether it is also correct.", kane: record };
  return { ...attempt, outcome: "inconclusive", reason: `Kane passed without testing the place this attempt names: ${reading.reason}`, kane: record };
}

/** Runs the attack: rules first, then one Kane run, read by the model, for each attempt the rules cannot settle. */
export async function runAttack(
  client: ModelClient,
  input: AttackInput,
  runKaneFor: (attempt: LazyFix) => Promise<KaneRun>,
  read?: (attempt: LazyFix, kane: KaneRun) => Promise<Diagnosis>,
): Promise<AttemptResult[]> {
  const results: AttemptResult[] = [];
  for (const attempt of await proposeLazyFixes(client, input)) {
    const byRule = judgeByRule(attempt, input);
    if (byRule) results.push(byRule);
    else if (!attempt.check) results.push({ ...attempt, outcome: "inconclusive", reason: "No browser check was written for this attempt." });
    else {
      const kane = await runKaneFor(attempt);
      const reading = read ? await read(attempt, kane).catch(() => undefined) : undefined;
      results.push(judgeByKane(attempt, kane, reading));
    }
  }
  return results;
}

/** The share-card and report line: only counts rejections that happened. */
export function attackSummary(results: AttemptResult[]): string {
  const rejected = results.filter(({ outcome }) => outcome === "rejected_by_rule" || outcome === "rejected_by_kane").length;
  const byKane = results.filter(({ outcome }) => outcome === "rejected_by_kane").length;
  if (rejected === 0) return "";
  return `${rejected} lazy ${rejected === 1 ? "fix" : "fixes"} rejected${byKane ? ` (${byKane} by Kane)` : ""}.`;
}

function normalise(text: string): string {
  return text.toLowerCase().replace(/[*_`"'.]/g, "").replace(/\s+/g, " ").trim();
}
