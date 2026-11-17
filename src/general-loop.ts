import type { Claim } from "./claims/types.js";
import type { Diagnose, Diagnosis } from "./diagnose.js";
import { distinctKaneRuns } from "./kane/evidence.js";
import type { KaneRun } from "./kane/runner.js";
import { KANE_RUN_LIMIT_REASON, type ClaimVerdict, type QuestionedRun, type Questioning, type RoundName, type RunRound } from "./loop-types.js";

/** What the general loop needs from the check: a model diagnoser and a way to turn a check into a full Kane objective. */
export interface GeneralQuestioning {
  diagnose: Diagnose;
  objectiveFor: (check: string) => string;
}

/** Rewordings allowed after an agent or check problem, before the claim is left unconfirmed. */
const MAX_REWORDS = 1;
const INITIAL_REASON = "Run the browser check extracted from the documentation, then have the model read Kane's result.";
const NOT_OUTDATED = "fibcheck did not check whether the claim was once true, so it is reported as false rather than outdated.";

const CAUSE_REASONS: Record<Diagnosis["cause"], string> = {
  agent_misstep: "Kane's own navigation caused the failure, and no rewording was left.",
  check_problem: "The check did not fit the app, and no rewording was left.",
  setup_problem: "Sign-in, test data or the environment prevented the test.",
  kane_limitation: "Kane cannot observe or perform what this claim needs.",
  claim_contradicted: "The failure looked like a contradiction, but the confirmation steps were not completed.",
  unclear: "The evidence did not show why the run failed.",
};

interface LoopState {
  claim: Claim;
  general: GeneralQuestioning;
  run: RunRound;
  canRunFollowUp: () => boolean;
  initial: KaneRun;
  followUps: Questioning["followUps"];
  overrides: Questioning["overrides"];
  diagnoses: NonNullable<Questioning["diagnoses"]>;
  rewordsLeft: number;
}

interface Attempt {
  round: RoundName;
  check: string;
  kane: KaneRun;
}

/**
 * Questions one claim without a hand-written check. Kane decides every pass
 * and failure. The model reads each result, says whether the run tested the
 * documented claim, and proposes a reworded check, a reproduction or a
 * control. A false verdict needs two distinct Kane failures that the model
 * reads as contradictions, a recorded reason the test was not at fault, and
 * a passing control.
 */
export async function questionGenerally(
  claim: Claim,
  check: string,
  general: GeneralQuestioning,
  run: RunRound,
  canRunFollowUp: () => boolean,
): Promise<QuestionedRun> {
  const initial = await run("initial", general.objectiveFor(check));
  const state: LoopState = { claim, general, run, canRunFollowUp, initial, followUps: [], overrides: [], diagnoses: [], rewordsLeft: MAX_REWORDS };
  let attempt: Attempt = { round: "initial", check, kane: initial };
  for (;;) {
    if (attempt.kane.status === "error" || attempt.kane.status === "cancelled") {
      return outcome(state, "unconfirmed", `Kane did not finish the run (${attempt.kane.status}).`);
    }
    const diagnosis = await review(state, attempt);
    if (!diagnosis) return outcome(state, "unconfirmed", "The model could not read Kane's result, so it was not interpreted.");
    const next = await decide(state, attempt, diagnosis);
    if ("questioning" in next) return next;
    attempt = next;
  }
}

async function decide(state: LoopState, attempt: Attempt, diagnosis: Diagnosis): Promise<QuestionedRun | Attempt> {
  if (attempt.kane.status === "passed") {
    if (diagnosis.exercisedClaim) return outcome(state, "true", `Kane passed a run that exercised the documented claim. ${diagnosis.reason}`);
    return await reword(state, diagnosis)
      ?? outcome(state, "unconfirmed", `Kane passed, but the run did not exercise the documented claim. ${diagnosis.reason}`);
  }
  if (diagnosis.cause === "claim_contradicted" && diagnosis.exercisedClaim) return await confirm(state, attempt, diagnosis);
  if (diagnosis.cause === "agent_misstep" || diagnosis.cause === "check_problem") {
    const next = await reword(state, diagnosis);
    if (next) return next;
  }
  return outcome(state, "unconfirmed", `${CAUSE_REASONS[diagnosis.cause]} ${diagnosis.reason}`);
}

async function reword(state: LoopState, diagnosis: Diagnosis): Promise<Attempt | undefined> {
  if (state.rewordsLeft <= 0 || !diagnosis.revisedCheck || !state.canRunFollowUp()) return undefined;
  state.rewordsLeft--;
  const kane = await state.run("reword", state.general.objectiveFor(diagnosis.revisedCheck));
  state.followUps.push({ purpose: "reword", reason: `Reworded after the model's reading: ${diagnosis.reason}`, kane });
  return { round: "reword", check: diagnosis.revisedCheck, kane };
}

async function confirm(state: LoopState, failed: Attempt, diagnosis: Diagnosis): Promise<QuestionedRun> {
  if (!diagnosis.ownMistakeRuledOut) return outcome(state, "unconfirmed", "The model gave no reason to rule out a test error.");
  if (!state.canRunFollowUp()) return outcome(state, "unconfirmed", KANE_RUN_LIMIT_REASON);
  // Repeat the exact check that failed, so the reproduction tests the same assertion.
  const check = failed.check;
  const kane = await state.run("retry", state.general.objectiveFor(check));
  return await confirmAfterReproduction(state, failed, diagnosis, { round: "retry", check, kane });
}

async function confirmAfterReproduction(state: LoopState, failed: Attempt, diagnosis: Diagnosis, reproduction: Attempt): Promise<QuestionedRun> {
  state.followUps.push({ purpose: "retry", reason: "Reproduce the same documented assertion in an independent Kane run.", kane: reproduction.kane });
  if (reproduction.kane.status !== "failed" || !distinctKaneRuns(reproduction.kane, failed.kane)) {
    return outcome(state, "unconfirmed", "Kane did not fail the documented assertion again in a separate run.");
  }
  const second = await review(state, reproduction);
  if (!second || second.cause !== "claim_contradicted" || !second.exercisedClaim) {
    return outcome(state, "unconfirmed", "The reproduction failed for a different reason, so the result is not consistent.");
  }
  if (!diagnosis.controlCheck || !state.canRunFollowUp()) {
    return outcome(state, "unconfirmed", diagnosis.controlCheck ? KANE_RUN_LIMIT_REASON : "The model proposed no control, so a setup problem was not ruled out.");
  }
  const control = await state.run("control", state.general.objectiveFor(diagnosis.controlCheck));
  state.followUps.push({ purpose: "control", reason: `Rule out a setup problem: ${diagnosis.controlCheck}`, kane: control });
  if (control.status !== "passed" || !distinctKaneRuns(control, failed.kane) || !distinctKaneRuns(control, reproduction.kane)) {
    return outcome(state, "unconfirmed", "The control did not pass in its own run, so a setup problem was not ruled out.");
  }
  return outcome(state, "false", `Two separate Kane runs failed the documented result. ${diagnosis.reason} Test error ruled out: ${diagnosis.ownMistakeRuledOut} The control passed. ${NOT_OUTDATED}`);
}

async function review(state: LoopState, attempt: Attempt): Promise<Diagnosis | undefined> {
  let diagnosis: Diagnosis;
  try {
    diagnosis = await state.general.diagnose(state.claim, attempt.check, attempt.kane);
  } catch {
    return undefined;
  }
  state.diagnoses.push({ round: attempt.round, cause: diagnosis.cause, exercisedClaim: diagnosis.exercisedClaim, reason: diagnosis.reason });
  const blame = attempt.kane.blame;
  if (blame && diagnosis.kaneBlame === "disagree" && diagnosis.blameEvidence) {
    state.overrides.push({ round: attempt.round, family: blame.family, category: blame.category, hypothesis: "The model read the evidence differently from Kane's own label.", evidence: diagnosis.blameEvidence });
  }
  return diagnosis;
}

function outcome(state: LoopState, verdict: ClaimVerdict, reason: string): QuestionedRun {
  const { initial, followUps, overrides, diagnoses } = state;
  return { kane: initial, questioning: { verdict, reason, initialReason: INITIAL_REASON, followUps, overrides, diagnoses } };
}
