import type { FailureCause } from "./diagnose.js";
import type { KaneRun, KaneRunOptions } from "./kane/runner.js";

/**
 * "worded_differently": the documented behaviour holds, but the visible interface text differs from the
 * documentation's wording. It is a pass, never a fib, and is reported as a wording suggestion.
 */
export type ClaimVerdict = "true" | "worded_differently" | "false" | "outdated" | "unconfirmed";
export const KANE_RUN_LIMIT_REASON = "The Kane run limit was reached before the required follow-up check.";
export type RoundName = "initial" | "reword" | "retry" | "control";

interface FollowUp {
  purpose: Exclude<RoundName, "initial">;
  reason: string;
  kane: KaneRun;
}

export interface Questioning {
  verdict: ClaimVerdict;
  reason: string;
  initialReason: string;
  followUps: FollowUp[];
  overrides: { round: RoundName; family: string; category: string; hypothesis: string; evidence: string }[];
  /** The model's reading of each round, for claims questioned by the general loop. */
  diagnoses?: { round: RoundName; cause: FailureCause; exercisedClaim: boolean; reason: string }[];
  /** For "worded_differently": the documentation's words and the text the interface actually shows. */
  wording?: { documented: string; visible: string };
  /** The automatic rule found a contradiction; the verdict stays unconfirmed until a person reviews the evidence. */
  candidateFinding?: boolean;
}

export type RunRound = (purpose: RoundName, objective: string, mode?: KaneRunOptions["assertionMode"]) => Promise<KaneRun>;

export interface QuestionedRun {
  kane: KaneRun;
  questioning: Questioning;
}
