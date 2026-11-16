import { describe, expect, it } from "vitest";
import type { Claim } from "./claims/types.js";
import { parseKaneOutput, type KaneObservation } from "./kane/parse.js";
import type { KaneRun } from "./kane/runner.js";
import { questionClaim } from "./loop.js";
import { loadTarget } from "./target.js";

const target = loadTarget("targets/linkding.json");
const claim: Claim = {
  id: "docs/src/content/docs/admin.md#L14",
  type: "ui_flow",
  quote: "To open the Admin app, go the *Settings* view and click on the *Admin* tab.",
  source: { file: "docs/src/content/docs/admin.md", startLine: 14, endLine: 14 },
};

const SETTINGS_PAGE = "/settings/general";
const ADMIN_PAGE = "/admin/";
const ready = observation("The Settings page shows the Profile form and its Save button.", "true", "true");
const tab = observation("The Settings page contains an in-page Admin tab.", "true", "false");
const dashboard = observation("The page title contains Site administration", "true", "true");
const item = observation("The Settings dropdown contains an Admin menu item.", "true", "true");
const access = observation("The Site administration dashboard shows the account pinotest and a Users management link.", "true", "true");

describe("questionClaim", () => {
  it("reports outdated after two independent tab failures and a passing access control", async () => {
    const { result, rounds } = await perform([miss("first"), miss("again"), passedControl()]);
    expect(rounds.map(({ purpose }) => purpose)).toEqual(["initial", "retry", "control"]);
    expect(rounds[0]?.objective).toContain(SETTINGS_PAGE);
    expect(rounds[1]?.objective).toContain(SETTINGS_PAGE);
    expect(rounds[1]?.objective).not.toBe(rounds[0]?.objective);
    expect(rounds.map(({ mode }) => mode)).toEqual(["visual", "visual", undefined]);
    expect(result.questioning).toMatchObject({
      verdict: "outdated",
      followUps: [{ purpose: "retry" }, { purpose: "control" }],
      overrides: [
        { round: "initial", family: "automation_bug", category: "test_data_issue" },
        { round: "retry", family: "automation_bug", category: "test_data_issue" },
      ],
    });
    expect(result.questioning.reason).toContain("same test login");
  });

  it("requires two distinct failed Kane runs", async () => {
    const first = miss("first");
    const { result, rounds } = await perform([first, { ...first }]);
    expect(rounds).toHaveLength(2);
    expect(result.questioning).toMatchObject({ verdict: "unconfirmed", overrides: [] });
  });

  it("leaves a failed assertion and a faithful pass unconfirmed", async () => {
    const confirmed = passedTab("again");
    const { result, rounds } = await perform([miss("first"), confirmed]);
    expect(rounds).toHaveLength(2);
    expect(result.questioning.reason).toContain("disagreed");
    expect(result.questioning.verdict).toBe("unconfirmed");
  });

  it("does not use a menu item pass to verify a tab", async () => {
    const { result, rounds } = await perform([passedControl()]);
    expect(rounds).toHaveLength(1);
    expect(result.questioning.verdict).toBe("unconfirmed");
  });

  it("requires a tab click for a true verdict", async () => {
    const first = passedTab("first");
    expect((await perform([first])).result.questioning.verdict).toBe("true");
    first.steps = [];
    expect((await perform([first])).result.questioning.verdict).toBe("unconfirmed");
  });

  it("does not retry an assertion from the wrong page", async () => {
    const { result, rounds } = await perform([run("failed", "first", [ADMIN_PAGE], [tab])]);
    expect(rounds).toHaveLength(1);
    expect(result.questioning.verdict).toBe("unconfirmed");
  });

  it("requires a passing readiness check before inspecting the tab", async () => {
    const first = miss("first");
    first.evidence.reverse().forEach((step, index) => { step.ordinal = index + 1; });
    const { result, rounds } = await perform([first]);
    expect(rounds).toHaveLength(1);
    expect(result.questioning.verdict).toBe("unconfirmed");
  });

  it("only reproduces the absence assertion, with visual evidence from that failed step", async () => {
    const disabled = observation("The Settings page Admin tab is enabled.", "true", "false");
    const wrongAssertion = run("failed", "again", [SETTINGS_PAGE], [disabled]);
    const unrelatedFailure = miss("again");
    unrelatedFailure.failedStep = { step: 4, status: "failed", remark: "assert: The tab is enabled." };
    const narrowSelector = run("failed", "again", [SETTINGS_PAGE], [{ ...tab, usedDomCode: true }]);
    for (const retry of [wrongAssertion, unrelatedFailure, narrowSelector]) {
      const { result, rounds } = await perform([miss("first"), retry]);
      expect(rounds).toHaveLength(2);
      expect(result.questioning.verdict).toBe("unconfirmed");
    }
  });

  it("does not issue a verdict or override when the control bypasses the dropdown", async () => {
    const control = passedControl();
    control.steps.push({ step: 3, status: "done", remark: "navigate: Go to /admin/" });
    const { result } = await perform([miss("first"), miss("again"), control]);
    expect(result.questioning).toMatchObject({ verdict: "unconfirmed", overrides: [] });
  });

  it("does not use the admin page title alone to establish account privileges", async () => {
    const control = passedControl();
    control.observations = [item, dashboard];
    const { result } = await perform([miss("first"), miss("again"), control]);
    expect(result.questioning).toMatchObject({ verdict: "unconfirmed", overrides: [] });
  });

  it("keeps older quotes that also claim a new window unconfirmed", async () => {
    const { result, rounds } = await perform([miss("first")], {
      ...claim,
      quote: claim.quote + " This should open a new window with the admin app.",
    });
    expect(rounds).toEqual([{ purpose: "initial", objective: "Original check", mode: undefined }]);
    expect(result.questioning.verdict).toBe("unconfirmed");
  });
});

function observation(condition: string, expectedValue: string, extractedValue: string): KaneObservation {
  return { name: "", condition, expectedValue, extractedValue, analyzerType: "visual", usedDomCode: false };
}

function run(status: "passed" | "failed", id: string, paths: string[], observations: KaneObservation[]): KaneRun {
  const start = new URL("/login", `http://localhost:${target.app.port}`);
  const reason_code = status === "failed" ? "assertion_error.final_verification" : "success.complete";
  const summary = `assert: ${observations[0]?.condition ?? ""}`;
  const failedStep = status === "failed" ? { step: 1, status: "failed" as const, remark: summary } : null;
  const evidence = paths.flatMap((path, index) => {
    const screenshot = {
      ordinal: index * 2 + 2, kind: "assert", status, summary, url: new URL(path, start).href,
      screenshot: "shot.jpg", annotated: null, failureYaml: null,
    };
    if (path !== SETTINGS_PAGE) return [screenshot];
    return [{ ...screenshot, ordinal: index * 2 + 1, status: "passed", summary: `assert: ${ready.condition}` }, screenshot];
  });
  return {
    ...parseKaneOutput(JSON.stringify({ type: "run_end", status, reason_code, session_dir: id }), status === "failed" ? 1 : 0),
    objective: "",
    startUrl: start.href,
    outDir: id,
    evidence,
    evidenceError: null,
    observations: paths.includes(SETTINGS_PAGE) ? [...observations, ready] : observations,
    failedStep,
  };
}

function miss(id: string): KaneRun {
  return {
    ...run("failed", id, [SETTINGS_PAGE], [tab]),
    blame: {
      family: "automation_bug", category: "test_data_issue", rootCause: "The account lacks administrator access.",
      confidence: null, agentFaultAssessment: "",
    },
  };
}

function passedControl(): KaneRun {
  const control = run("passed", "control", [ADMIN_PAGE], [item, dashboard, access]);
  control.steps = [
    { step: 1, status: "done", remark: "click: Open Settings dropdown" },
    { step: 2, status: "done", remark: "click: Click Admin in the dropdown" },
  ];
  return control;
}

function passedTab(id: string): KaneRun {
  const result = run("passed", id, [SETTINGS_PAGE, ADMIN_PAGE], [{ ...tab, extractedValue: "true" }, dashboard]);
  result.steps = [{ step: 3, status: "done", remark: "click: Click the in-page Admin tab" }];
  return result;
}

async function perform(runs: KaneRun[], selected = claim) {
  const rounds: { purpose: string; objective: string; mode?: string }[] = [];
  const result = await questionClaim(selected, target, "Original check", async (purpose, objective, mode) => {
    rounds.push({ purpose, objective, mode });
    const response = runs[rounds.length - 1];
    if (!response) throw new Error("Unexpected Kane round");
    return response;
  });
  return { result, rounds };
}
