import type { Claim } from "./claims/types.js";
import type { KaneRun } from "./kane/runner.js";
import type { ModelClient } from "./model/client.js";

/** The model's reading of why a Kane run ended as it did. Kane alone decides passed or failed. */
export const FAILURE_CAUSES = ["agent_misstep", "check_problem", "setup_problem", "kane_limitation", "claim_contradicted", "unclear"] as const;
export type FailureCause = (typeof FAILURE_CAUSES)[number];

export interface Diagnosis {
  /** Whether the run tested the documented place, control type and each stated result. */
  exercisedClaim: boolean;
  /** For a failed or unfinished run: the most likely cause. For a passing run: "unclear". */
  cause: FailureCause;
  reason: string;
  /** Why the failure is not the test's own fault. Required before a contradiction counts. */
  ownMistakeRuledOut: string;
  kaneBlame: "agree" | "disagree" | "none";
  /** The step or observation that contradicts Kane's blame label, when the model disagrees. */
  blameEvidence: string;
  /** A corrected check after an agent or check problem, or for a pass that did not test the claim. */
  revisedCheck: string;
  /** For a contradiction: a nearby flow that should pass if the setup is valid. */
  controlCheck: string;
}

export type Diagnose = (claim: Claim, check: string, kane: KaneRun) => Promise<Diagnosis>;

export const DIAGNOSE_SYSTEM = `You review one Kane CLI browser test run. The run checked a claim from a web app's public documentation. Kane alone decides whether its run passed or failed, and you never change that. Your job is to read the run and say what it means for the claim.

1. Decide whether the run exercised the documented claim: the same page or place, the same kind of control (tab, menu item, button, field), and each stated result. A pass that reached the result through a different place or a different kind of control did not exercise the claim.
2. For a failed or unfinished run, name the most likely cause:
- agent_misstep: Kane used the wrong control or page, misread the screen, ran out of steps, or stopped although a valid path was visible.
- check_problem: the check was wrong or ambiguous, named a control that does not exist, or asserted something the claim does not state.
- setup_problem: sign-in did not complete, test data or a fixture was missing, or the environment blocked the test.
- kane_limitation: Kane cannot observe or perform what the claim needs. Known limits: Kane cannot inspect new browser tabs or windows; Kane's text entry can bypass editors that convert Markdown or other syntax as you type, so literal syntax in a saved result can come from the input method; a word used as a stored variable name can drop out of a condition.
- claim_contradicted: the right page was loaded, the setup was valid, Kane performed the documented action in the documented place, and the documented result was observably absent.
- unclear: none of the above is supported by the evidence.
Observations such as "the login form is shown" or "the welcome wizard opens" are usually Kane checking a conditional instruction at the start of the run. They do not show the app's state later in the run. Judge sign-in and setup from the later steps.
Choose claim_contradicted only when the evidence shows every part of that definition. Otherwise choose another cause. A wrong accusation against an open-source project is far worse than a missed finding.
For a passing run, use cause "unclear".
3. Kane's blame label is a hypothesis, not a fact. Say whether you agree. If you disagree, cite the specific step or observation that contradicts it in blameEvidence.
4. Propose the next check:
- revisedCheck: for agent_misstep or check_problem, a corrected sequence of browser actions and explicit assertions that still tests exactly what the claim states, in the same place, with the same control type and each stated result. Never weaken a check so that it passes. For a passing run that did not exercise the claim, a check that does. Otherwise leave it empty.
- controlCheck: for claim_contradicted only, a nearby flow in the same app with the same login that should pass if the setup is valid and that does not depend on the disputed claim. Otherwise leave it empty.
- ownMistakeRuledOut: for claim_contradicted, why the failure is not caused by the test itself (sign-in, test data, Kane's input method, the wrong page). Otherwise leave it empty.
Write plain sentences. Do not include URLs, file paths or credentials. Do not ask Kane to sign in again; the login instructions are added separately.`;

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    exercisedClaim: { type: "boolean" },
    cause: { type: "string", enum: [...FAILURE_CAUSES] },
    reason: { type: "string" },
    ownMistakeRuledOut: { type: "string" },
    kaneBlame: { type: "string", enum: ["agree", "disagree", "none"] },
    blameEvidence: { type: "string" },
    revisedCheck: { type: "string" },
    controlCheck: { type: "string" },
  },
  required: ["exercisedClaim", "cause", "reason", "ownMistakeRuledOut", "kaneBlame", "blameEvidence", "revisedCheck", "controlCheck"],
} as const;

const MAX_STEPS = 60;
const MAX_OBSERVATIONS = 30;
const MAX_TEXT = 600;

/** Builds a diagnoser that sends only public claim text and a sanitized Kane summary to the model. */
export function modelDiagnoser(client: ModelClient, secrets: readonly string[] = []): Diagnose {
  return async (claim, check, kane) => {
    const { value } = await client.generateJson(
      { purpose: "diagnose-run", system: DIAGNOSE_SYSTEM, prompt: diagnosisPrompt(claim, check, kane, secrets), jsonSchema: RESPONSE_SCHEMA },
      parseDiagnosis,
    );
    return value;
  };
}

/** The model's input: the public claim, the check and Kane's result without URLs, paths, session links or secrets. */
export function diagnosisPrompt(claim: Claim, check: string, kane: KaneRun, secrets: readonly string[] = []): string {
  const clean = (text: string | undefined | null) => sanitize(text ?? "", secrets);
  const summary = {
    claim: { file: claim.source.file, line: claim.source.startLine, quote: clean(claim.quote) },
    check: clean(check),
    kane: {
      status: kane.status,
      reasonCode: kane.reasonCode,
      oneLiner: clean(kane.oneLiner),
      reason: clean(kane.reason),
      failedStep: kane.failedStep ? clean(kane.failedStep.remark) : null,
      steps: kane.steps.slice(-MAX_STEPS).map((step) => `${step.status}: ${clean(step.remark)}`),
      observations: kane.observations.slice(-MAX_OBSERVATIONS).map((o) => ({
        condition: clean(o.condition), expected: clean(o.expectedValue), observed: clean(o.extractedValue),
      })),
      blame: kane.blame ? {
        family: kane.blame.family, category: kane.blame.category,
        rootCause: clean(kane.blame.rootCause), agentFaultAssessment: clean(kane.blame.agentFaultAssessment),
      } : null,
    },
  };
  return `Review this Kane run.\n\n${JSON.stringify(summary, null, 2)}`;
}

function sanitize(text: string, secrets: readonly string[]): string {
  let result = text;
  for (const secret of secrets) if (secret.length >= 4) result = result.split(secret).join("[secret]");
  result = result
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[url]")
    .replace(/(?:\blocalhost|\b(?:\d{1,3}\.){3}\d{1,3}|\[[0-9a-f:]+\])(?::\d+)?(?:\/\S*)?/gi, "[url]")
    .replace(/(?:~|\b[A-Za-z]:)?[\\/](?:Users|home|private|tmp|var|opt|root|mnt|Volumes)[\\/]\S+/g, "[path]")
    .replace(/~\/\S+/g, "[path]");
  return result.length > MAX_TEXT ? `${result.slice(0, MAX_TEXT)}…` : result;
}

export function parseDiagnosis(value: unknown): Diagnosis {
  if (typeof value !== "object" || value === null) throw new Error("The diagnosis was not an object.");
  const record = value as Record<string, unknown>;
  const text = (key: string) => {
    const field = record[key];
    if (field === undefined || field === null) return "";
    if (typeof field !== "string") throw new Error(`The diagnosis field ${key} was not text.`);
    return field.trim();
  };
  const cause = record.cause;
  if (typeof cause !== "string" || !(FAILURE_CAUSES as readonly string[]).includes(cause)) throw new Error("The diagnosis named an unknown cause.");
  const blame = record.kaneBlame;
  if (blame !== "agree" && blame !== "disagree" && blame !== "none") throw new Error("The diagnosis gave an unknown blame opinion.");
  if (typeof record.exercisedClaim !== "boolean") throw new Error("The diagnosis did not say whether the run exercised the claim.");
  return {
    exercisedClaim: record.exercisedClaim,
    cause: cause as FailureCause,
    reason: text("reason"),
    ownMistakeRuledOut: text("ownMistakeRuledOut"),
    kaneBlame: blame,
    blameEvidence: text("blameEvidence"),
    revisedCheck: text("revisedCheck"),
    controlCheck: text("controlCheck"),
  };
}
