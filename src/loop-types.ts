import type { KaneRun, KaneRunOptions } from "./kane/runner.js";

export type ClaimVerdict = "true" | "false" | "outdated" | "unconfirmed";
export const KANE_RUN_LIMIT_REASON = "The Kane run limit was reached before the required follow-up check.";
type RoundName = "initial" | "retry" | "control";

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
}

export type RunRound = (purpose: RoundName, objective: string, mode?: KaneRunOptions["assertionMode"]) => Promise<KaneRun>;

export interface QuestionedRun {
  kane: KaneRun;
  questioning: Questioning;
}
