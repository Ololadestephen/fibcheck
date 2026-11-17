import { describe, expect, it } from "vitest";
import type { Claim } from "./claims/types.js";
import type { Diagnosis } from "./diagnose.js";
import { questionGenerally } from "./general-loop.js";
import { parseKaneOutput, type KaneBlame } from "./kane/parse.js";
import type { KaneRun } from "./kane/runner.js";
import { KANE_RUN_LIMIT_REASON } from "./loop-types.js";
import { questionClaim } from "./loop.js";

const claim: Claim = {
  id: "README.md#L29",
  type: "behaviour",
  quote: "using Markdown to give your words more structure",
  source: { file: "README.md", startLine: 29, endLine: 29 },
  check: "Create a memo with a Markdown heading and verify it renders as a heading.",
};

const productBlame: KaneBlame = { family: "application_issue", category: "functional_defect", rootCause: "The app did not render.", confidence: 0.9, agentFaultAssessment: "" };

function kane(status: KaneRun["status"], id: string, blame: KaneBlame | null = null): KaneRun {
  const exit = status === "passed" ? 0 : status === "error" ? 2 : 1;
  return {
    ...parseKaneOutput(JSON.stringify({ type: "run_end", status, reason_code: status === "passed" ? "success.complete" : "assertion_error.checkpoint_failed", session_dir: `/sessions/${id}`, test_url: `https://example.test/${id}` }), exit),
    objective: "", startUrl: "http://localhost:1/", outDir: id, evidence: [], evidenceError: null, blame,
  };
}

function diagnosis(overrides: Partial<Diagnosis>): Diagnosis {
  return {
    exercisedClaim: true, cause: "unclear", reason: "Reason.", ownMistakeRuledOut: "", kaneBlame: "none",
    blameEvidence: "", revisedCheck: "", controlCheck: "", ...overrides,
  };
}

const contradiction = diagnosis({
  cause: "claim_contradicted", reason: "The heading stayed literal.", ownMistakeRuledOut: "Sign-in completed and the memo was saved.",
  revisedCheck: "Repeat: create a memo with a heading and verify it renders.", controlCheck: "Create a plain memo and verify it is saved.",
});

async function perform(runs: KaneRun[], readings: (Diagnosis | Error)[], limit = Infinity) {
  const rounds: { purpose: string; objective: string }[] = [];
  const reviewed: string[] = [];
  const result = await questionGenerally(claim, claim.check ?? "", {
    diagnose: async (_claim, check) => {
      reviewed.push(check);
      const reading = readings[reviewed.length - 1];
      if (!reading) throw new Error("Unexpected diagnosis");
      if (reading instanceof Error) throw reading;
      return reading;
    },
    objectiveFor: (check) => `LOGIN. ${check}`,
  }, async (purpose, objective) => {
    rounds.push({ purpose, objective });
    const response = runs[rounds.length - 1];
    if (!response) throw new Error("Unexpected Kane round");
    return response;
  }, () => rounds.length < limit);
  return { result, rounds, reviewed };
}

describe("questionGenerally", () => {
  it("calls a claim true when Kane passed and the run exercised the claim", async () => {
    const { result, rounds } = await perform([kane("passed", "a")], [diagnosis({})]);
    expect(result.questioning.verdict).toBe("true");
    expect(rounds).toEqual([{ purpose: "initial", objective: `LOGIN. ${claim.check}` }]);
  });

  it("rewords a pass that did not exercise the claim, then accepts a faithful pass", async () => {
    const { result, rounds } = await perform(
      [kane("passed", "a"), kane("passed", "b")],
      [diagnosis({ exercisedClaim: false, revisedCheck: "Use the in-page tab." }), diagnosis({})],
    );
    expect(rounds.map(({ purpose }) => purpose)).toEqual(["initial", "reword"]);
    expect(rounds[1]?.objective).toBe("LOGIN. Use the in-page tab.");
    expect(result.questioning).toMatchObject({ verdict: "true", followUps: [{ purpose: "reword" }] });
  });

  it("leaves an unfaithful pass unconfirmed when no rewording is proposed", async () => {
    const { result, rounds } = await perform([kane("passed", "a")], [diagnosis({ exercisedClaim: false })]);
    expect(result.questioning.verdict).toBe("unconfirmed");
    expect(rounds).toHaveLength(1);
  });

  it("marks a candidate finding only after two contradicted failures and a passing control, and never calls it false", async () => {
    const { result, rounds, reviewed } = await perform(
      [kane("failed", "a", productBlame), kane("failed", "b"), kane("passed", "c")],
      [contradiction, contradiction],
    );
    expect(rounds.map(({ purpose }) => purpose)).toEqual(["initial", "retry", "control"]);
    expect(rounds[1]?.objective).toBe(`LOGIN. ${claim.check}`);
    expect(rounds[2]?.objective).toBe(`LOGIN. ${contradiction.controlCheck}`);
    expect(reviewed).toEqual([claim.check, claim.check]);
    expect(result.questioning).toMatchObject({ verdict: "unconfirmed", candidateFinding: true });
    expect(result.questioning.reason).toContain(contradiction.ownMistakeRuledOut);
    expect(result.questioning.reason).toContain("rather than outdated");
    expect(result.questioning.diagnoses?.map(({ round }) => round)).toEqual(["initial", "retry"]);
  });

  it("rewords after an agent misstep and records a blame override", async () => {
    const { result, rounds } = await perform(
      [kane("failed", "a", productBlame), kane("passed", "b")],
      [diagnosis({ cause: "agent_misstep", kaneBlame: "disagree", blameEvidence: "The screenshot shows only static help text.", revisedCheck: "Wait for the editor." }), diagnosis({})],
    );
    expect(rounds.map(({ purpose }) => purpose)).toEqual(["initial", "reword"]);
    expect(result.questioning).toMatchObject({
      verdict: "true",
      overrides: [{ round: "initial", family: "application_issue", category: "functional_defect", evidence: "The screenshot shows only static help text." }],
    });
  });

  it("rewords at most once", async () => {
    const misstep = diagnosis({ cause: "agent_misstep", revisedCheck: "Try again." });
    const { result, rounds } = await perform([kane("failed", "a"), kane("failed", "b")], [misstep, misstep]);
    expect(rounds).toHaveLength(2);
    expect(result.questioning.verdict).toBe("unconfirmed");
  });

  it.each(["setup_problem", "kane_limitation", "unclear"] as const)("stops without more Kane runs for %s", async (cause) => {
    const { result, rounds } = await perform([kane("failed", "a")], [diagnosis({ cause, revisedCheck: "Something else." })]);
    expect(rounds).toHaveLength(1);
    expect(result.questioning.verdict).toBe("unconfirmed");
  });

  it("needs a recorded reason that the test was not at fault", async () => {
    const { result, rounds } = await perform([kane("failed", "a")], [{ ...contradiction, ownMistakeRuledOut: "" }]);
    expect(rounds).toHaveLength(1);
    expect(result.questioning.verdict).toBe("unconfirmed");
  });

  it("treats a contradiction the run did not exercise as unconfirmed", async () => {
    const { result } = await perform([kane("failed", "a")], [{ ...contradiction, exercisedClaim: false, revisedCheck: "" }]);
    expect(result.questioning.verdict).toBe("unconfirmed");
  });

  it("stays unconfirmed when the reproduction passes", async () => {
    const { result, rounds } = await perform([kane("failed", "a"), kane("passed", "b")], [contradiction]);
    expect(rounds.map(({ purpose }) => purpose)).toEqual(["initial", "retry"]);
    expect(result.questioning.verdict).toBe("unconfirmed");
  });

  it("stays unconfirmed when the reproduction is the same Kane run", async () => {
    const { result } = await perform([kane("failed", "a"), kane("failed", "a")], [contradiction, contradiction]);
    expect(result.questioning.verdict).toBe("unconfirmed");
  });

  it("stays unconfirmed when the reproduction fails for another reason", async () => {
    const { result, rounds } = await perform([kane("failed", "a"), kane("failed", "b")], [contradiction, diagnosis({ cause: "agent_misstep" })]);
    expect(rounds).toHaveLength(2);
    expect(result.questioning.verdict).toBe("unconfirmed");
  });

  it("stays unconfirmed when the control fails", async () => {
    const { result } = await perform([kane("failed", "a"), kane("failed", "b"), kane("failed", "c")], [contradiction, contradiction]);
    expect(result.questioning.verdict).toBe("unconfirmed");
  });

  it("stays unconfirmed when the control is the same Kane run as a failure", async () => {
    const { result } = await perform([kane("failed", "a"), kane("failed", "b"), kane("passed", "b")], [contradiction, contradiction]);
    expect(result.questioning.verdict).toBe("unconfirmed");
  });

  it("stays unconfirmed when the model cannot read the reproduction", async () => {
    const { result, rounds } = await perform([kane("failed", "a"), kane("failed", "b")], [contradiction, new Error("quota")]);
    expect(rounds).toHaveLength(2);
    expect(result.questioning.verdict).toBe("unconfirmed");
  });

  it("reproduces a contradiction found in a reworded run with the reworded check", async () => {
    const { result, rounds } = await perform(
      [kane("failed", "a"), kane("failed", "b"), kane("failed", "c"), kane("passed", "d")],
      [diagnosis({ cause: "check_problem", revisedCheck: "Use the footer menu." }), contradiction, contradiction],
    );
    expect(rounds.map(({ purpose }) => purpose)).toEqual(["initial", "reword", "retry", "control"]);
    expect(rounds[2]?.objective).toBe("LOGIN. Use the footer menu.");
    expect(result.questioning).toMatchObject({ verdict: "unconfirmed", candidateFinding: true });
  });

  it("stays unconfirmed without a proposed control", async () => {
    const { result, rounds } = await perform([kane("failed", "a"), kane("failed", "b")], [{ ...contradiction, controlCheck: "" }, contradiction]);
    expect(rounds).toHaveLength(2);
    expect(result.questioning.verdict).toBe("unconfirmed");
  });

  it("respects the Kane run limit", async () => {
    const { result, rounds } = await perform([kane("failed", "a"), kane("failed", "b")], [contradiction, contradiction], 2);
    expect(rounds).toHaveLength(2);
    expect(result.questioning).toMatchObject({ verdict: "unconfirmed", reason: KANE_RUN_LIMIT_REASON });
  });

  it("does not interpret a run Kane did not finish", async () => {
    const { result, reviewed } = await perform([kane("error", "a")], []);
    expect(reviewed).toEqual([]);
    expect(result.questioning.verdict).toBe("unconfirmed");
  });

  it("stays unconfirmed when the model cannot answer", async () => {
    const { result } = await perform([kane("failed", "a")], [new Error("quota")]);
    expect(result.questioning.verdict).toBe("unconfirmed");
  });

  it("is used by questionClaim for claims without a reviewed check", async () => {
    const rounds: string[] = [];
    const result = await questionClaim(claim, undefined, "Original", async (purpose) => {
      rounds.push(purpose);
      return kane("passed", "a");
    }, undefined, () => true, { diagnose: async () => diagnosis({}), objectiveFor: (check) => check });
    expect(rounds).toEqual(["initial"]);
    expect(result.questioning.verdict).toBe("true");
  });
});
