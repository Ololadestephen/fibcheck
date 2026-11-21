import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseKaneOutput } from "./parse.js";

const fixture = (name: string) => readFileSync(`fixtures/kane/${name}`, "utf8");

describe("parseKaneOutput on real Kane CLI 0.10.4 output", () => {
  it("reads a failed final verification with Kane's blame label", () => {
    const r = parseKaneOutput(fixture("failed-final-verification.ndjson"), 1);
    expect(r.status).toBe("failed");
    expect(r.reasonCode).toBe("assertion_error.final_verification");
    expect(r.credits).toBeCloseTo(34.395, 2);
    expect(r.durationSec).toBe(68);
    expect(r.failedStep?.status).toBe("failed");
    expect(r.blame).toMatchObject({ family: "automation_bug", category: "test_data_issue" });
    expect(r.blame?.confidence).toBeCloseTo(0.91);
    expect(r.evidencePack).toMatch(/\.evidence$/);
    expect(r.sessionDir).toContain("/home/user/.testmuai/kaneai/sessions/");
  });

  it("reads a passed run with the values Kane observed", () => {
    const r = parseKaneOutput(fixture("passed.ndjson"), 0);
    expect(r.status).toBe("passed");
    expect(r.failedStep).toBeNull();
    expect(r.blame).toBeNull();
    expect(r.steps.length).toBeGreaterThan(3);
    expect(r.observations.some((o) => o.extractedValue === "true")).toBe(true);
  });

  it("reads a run Kane could not complete", () => {
    const r = parseKaneOutput(fixture("failed-step-not-achievable.ndjson"), 1);
    expect(r.status).toBe("failed");
    expect(r.reasonCode).toBe("assertion_error.step_not_achievable");
    expect(r.blame?.category).toBe("config_issue");
  });
});

describe("parseKaneOutput edge cases", () => {
  it("treats exit code 2 as a run that did not start", () => {
    const r = parseKaneOutput('{"type":"error","message":"Not authenticated","v":1}\n', 2);
    expect(r).toMatchObject({ status: "error", reason: "Not authenticated", credits: null });
  });

  it("treats exit code 3 as cancelled", () => {
    expect(parseKaneOutput("", 3).status).toBe("cancelled");
  });

  it("treats a pass with a non-zero exit as inconclusive, neither pass nor fail", () => {
    const r = parseKaneOutput('{"type":"run_end","status":"passed"}\n', 1);
    expect(r.status).toBe("error");
    expect(r.reason).toMatch(/inconclusive/);
  });

  it("skips memory entries that are not objects", () => {
    const end = { type: "run_end", status: "passed", context: { memory: { bad: null, good: { condition: "c", extracted_value: "e", expected_value: "x" } } } };
    expect(parseKaneOutput(`${JSON.stringify(end)}\n`, 0).observations.map(({ name }) => name)).toEqual(["good"]);
  });

  it("counts and skips lines that are not JSON", () => {
    const r = parseKaneOutput('hello\n{"step":2,"status":"done","remark":"ok"}\n', 1);
    expect(r.ignoredLines).toBe(1);
    expect(r.steps).toEqual([{ step: 2, status: "done", remark: "ok" }]);
    expect(r.status).toBe("error");
  });
});
