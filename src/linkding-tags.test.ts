import { describe, expect, it, vi } from "vitest";
import type { Claim } from "./claims/types.js";
import { parseKaneOutput, type KaneObservation } from "./kane/parse.js";
import type { KaneRun } from "./kane/runner.js";
import { linkdingTagClaim } from "./linkding-tags.js";
import { questionClaim } from "./loop.js";
import type { RunRound } from "./loop-types.js";
import { loadTarget, resolveTarget } from "./target.js";

const target = loadTarget("targets/linkding.json");
const startUrl = new URL("/login/", resolveTarget(target).baseUrl).href;
const source = { file: "docs/src/content/docs/admin.md", startLine: 55, endLine: 55 };
const ordinary: Claim = { id: "admin.md#L55", source, type: "behaviour", quote: "While linkding UI currently only allows to create or assign tags," };
const admin: Claim = { ...ordinary, id: "admin.md#L55-2", quote: "you can use the admin app to manage your tags." };
const row = "The ordinary Linkding Tags page lists pinocchiotag.";
const edit = "The pinocchiotag row has an Edit control on the ordinary Linkding Tags page.";
const originalName = "The Edit Tag Name field is pinocchiotag.";
const mainRenamed = "The ordinary Linkding Tags page lists pinocchiotagmain.";
const adminRenamed = "The Site administration Tags list contains pinocchioadmintagproof.";

describe("Linkding tag claims", () => {
  it("matches each clause independently and rejects the old compound extraction", () => {
    expect(linkdingTagClaim(ordinary)).toBe("main");
    expect(linkdingTagClaim(admin)).toBe("admin");
    expect(linkdingTagClaim({ ...ordinary, quote: `${ordinary.quote} ${admin.quote}` })).toBeUndefined();
  });

  it("requires two independent observed failures and a successful ordinary rename", async () => {
    const initial = failure("first", "assertion_error.confirmed_product_bug");
    initial.blame = blame("application_issue", "ui_state_mismatch", "The ordinary app user should not be able to edit.");
    const retry = failure("other");
    retry.blame = blame("automation_bug", "config_issue", "The test expectation is wrong for the page that was loaded.");
    const { result, calls, seed } = await review(ordinary, [initial, retry, rename(false)]);
    expect(calls.map(([round, , mode]) => [round, mode])).toEqual([["initial", "visual"], ["retry", "visual"], ["control", "dom"]]);
    expect(seed).toHaveBeenCalledOnce();
    expect(result.questioning).toMatchObject({
      verdict: "outdated",
      overrides: [{ family: "application_issue" }, { family: "automation_bug" }],
    });
  });

  it("leaves the claim unconfirmed when the test tag was never seen", async () => {
    const initial = failure("first");
    initial.observations = initial.observations.filter((o) => !o.condition.startsWith(row));
    const { result, calls } = await review(ordinary, [initial]);
    expect(calls).toHaveLength(1);
    expect(result.questioning).toMatchObject({ verdict: "unconfirmed", overrides: [] });
  });

  it("rejects a reproduction from the same session or from the admin page", async () => {
    const badRoute = failure("second");
    for (const screenshot of badRoute.evidence) screenshot.url = new URL("/admin/bookmarks/tag/", startUrl).href;
    for (const retry of [failure("first"), badRoute]) {
      const { result, calls } = await review(ordinary, [failure("first"), retry]);
      expect(calls).toHaveLength(2);
      expect(result.questioning.verdict).toBe("unconfirmed");
    }
  });

  it("rejects a passing rename outside the ordinary Tags page", async () => {
    const { result } = await review(ordinary, [failure("first"), failure("second"), rename(true)]);
    expect(result.questioning).toMatchObject({ verdict: "unconfirmed", overrides: [] });
  });

  it("binds the actual name entry and Save to the same UI as the result assertion", async () => {
    const control = rename(false);
    const adminCheck = rename(true);
    for (const [run, route] of [[control, "/admin/bookmarks/tag/2/change/"], [adminCheck, "/tags"]] as const) {
      for (const step of run.evidence.filter((event) => event.kind === "type" || event.summary === "click: Click Save")) {
        step.url = new URL(route, startUrl).href;
      }
    }
    expect((await review(ordinary, [failure("first"), failure("second"), control])).result.questioning.verdict).toBe("unconfirmed");
    expect((await review(admin, [adminCheck])).result.questioning.verdict).toBe("unconfirmed");
  });

  it("uses the original name before typing when Kane calls the row 'that tag'", async () => {
    const control = renameWithIdentity();
    const { result, calls } = await review(ordinary, [failure("first"), failure("second"), control]);
    expect(calls[2]?.[1]).toContain(originalName);
    expect(result.questioning.verdict).toBe("outdated");
  });

  it("requires matching, ordered identity evidence for new controls", async () => {
    const missingCapture = renameWithIdentity();
    missingCapture.evidence = missingCapture.evidence.filter((step) => !step.summary.includes(originalName));
    const missingObservation = renameWithIdentity();
    missingObservation.observations = missingObservation.observations.filter((item) => !item.condition.includes(originalName));
    const lateCapture = renameWithIdentity();
    const checked = lateCapture.evidence.find((step) => step.summary.includes(originalName));
    if (!checked) throw new Error("Expected an original-name capture in the fixture.");
    checked.ordinal = 4;
    for (const control of [missingCapture, missingObservation, lateCapture]) {
      expect((await review(ordinary, [failure("first"), failure("second"), control])).result.questioning.verdict).toBe("unconfirmed");
    }
  });

  it("accepts an exact tag-name comparison and rejects a different tag name", async () => {
    const control = renameWithIdentity();
    const identity = control.observations.find((item) => item.condition.includes(originalName));
    if (!identity) throw new Error("Expected a name observation.");
    identity.expectedValue = "pinocchiotag";
    identity.extractedValue = "pinocchiotag";
    expect((await review(ordinary, [failure("first"), failure("second"), control])).result.questioning.verdict).toBe("outdated");
    for (const name of ["pinocchioadmintag", "pinocchio_tag", "PINOCCHIOTAG"]) {
      identity.extractedValue = name;
      expect((await review(ordinary, [failure("first"), failure("second"), control])).result.questioning.verdict).toBe("unconfirmed");
    }
  });

  it("rejects switching to a different Edit form before typing or saving", async () => {
    for (const ordinal of [3, 4]) {
      const control = renameWithIdentity();
      for (const step of control.evidence) if (step.ordinal >= ordinal) step.ordinal++;
      control.evidence.push({ ...capture(ordinal, "/tags", "passed", ""), kind: "click", summary: "click: Edit a different tag" });
      expect((await review(ordinary, [failure("first"), failure("second"), control])).result.questioning.verdict).toBe("unconfirmed");
    }
  });

  it("rejects a later unrelated assertion that follows the canonical Edit sentence", async () => {
    const result = failure("first");
    const unrelated = { step: 2, status: "failed" as const, remark: `assert: ${edit} The page title is missing.` };
    result.failedStep = unrelated;
    result.evidence[1]!.summary = unrelated.remark;
    expect((await review(ordinary, [result])).result.questioning.verdict).toBe("unconfirmed");
  });

  it("confirms the admin clause only when Kane saves the rename in Site administration", async () => {
    const passed = rename(true);
    expect((await review(admin, [passed])).result.questioning.verdict).toBe("true");
    const missingSave = { ...passed, evidence: passed.evidence.filter((step) => !step.summary.includes("Save")) };
    expect((await review(admin, [missingSave])).result.questioning.verdict).toBe("unconfirmed");
    expect((await review(admin, [rename(false)])).result.questioning.verdict).toBe("unconfirmed");
  });

  it("does not use a seeded flow on a user-managed app", async () => {
    const run = vi.fn<RunRound>().mockResolvedValue(rename(true));
    const result = await questionClaim(admin, undefined, "Original check", run);
    expect(run).toHaveBeenCalledExactlyOnceWith("initial", "Original check");
    expect(result.questioning.verdict).toBe("unconfirmed");
  });
});

const observation = (condition: string, expectedValue = "true", extractedValue = "true"): KaneObservation =>
  ({ name: "", condition: condition + ` Expect ${expectedValue}.`, expectedValue, extractedValue });

function blame(family: string, category: string, rootCause: string): KaneRun["blame"] {
  return { family, category, rootCause, confidence: null, agentFaultAssessment: "" };
}

function runResult(id: string, status: "passed" | "failed", reasonCode: string): KaneRun {
  return {
    ...parseKaneOutput(JSON.stringify({ type: "run_end", status, reason_code: reasonCode, session_dir: id }), status === "passed" ? 0 : 1),
    objective: "", startUrl, outDir: id, evidenceError: null, evidence: [],
  };
}

function capture(ordinal: number, route: string, status: string, assertion: string) {
  return {
    ordinal, url: new URL(route, startUrl).href, kind: "assert", status, summary: `assert: ${assertion}`,
    screenshot: "step.jpg", annotated: null, failureYaml: null,
  };
}

function failure(id: string, reasonCode = "assertion_error.final_verification"): KaneRun {
  const result = runResult(id, "failed", reasonCode);
  const failed = capture(2, "/tags", "failed", edit + " Exp");
  result.failedStep = { step: 2, status: "failed", remark: failed.summary };
  result.observations = [observation(row), observation(edit, "false", "true")];
  result.evidence = [capture(1, "/tags", "passed", row), failed];
  return result;
}

function rename(usingAdmin: boolean): KaneRun {
  const result = runResult("control", "passed", "success.complete");
  const [original, renamed, assertion, path] = usingAdmin
    ? ["pinocchioadmintag", "pinocchioadmintagproof", adminRenamed, "/admin/bookmarks/tag/"]
    : ["pinocchiotag", "pinocchiotagmain", mainRenamed, "/tags"];
  const editPath = usingAdmin ? "/admin/bookmarks/tag/2/change/" : path;
  result.observations = [observation(assertion)];
  result.evidence = [
    { ...capture(1, path, "passed", ""), kind: "click", summary: `click: Click ${usingAdmin ? "" : "Edit on "} ${original}` },
    { ...capture(2, editPath, "passed", ""), kind: "type", summary: `type: Type "${renamed}" into Name` },
    { ...capture(3, editPath, "passed", ""), kind: "click", summary: "click: Click Save" },
    capture(4, path, "passed", assertion),
  ];
  return result;
}

function renameWithIdentity(): KaneRun {
  const result = rename(false);
  result.objective = `Check the original name. ${originalName}`;
  result.observations.push(observation(originalName));
  for (const step of result.evidence) {
    if (step.ordinal === 1) step.summary = "click: PRIMARY: edit that tag";
    else step.ordinal++;
  }
  result.evidence.push(capture(2, "/tags", "passed", originalName));
  return result;
}

async function review(claim: Claim, results: KaneRun[]) {
  const run = vi.fn<RunRound>().mockImplementation(async () => {
    const result = results.shift();
    if (!result) throw new Error("Unexpected Kane round");
    return result;
  });
  const seed = vi.fn(async () => {});
  const result = await questionClaim(claim, target, "Original check", run, seed);
  return { result, calls: run.mock.calls, seed };
}
