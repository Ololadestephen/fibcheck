import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { cardText } from "./card.js";
import { confirmFinding } from "./confirm.js";
import { loadFindings } from "./findings.js";

const COMMIT = "c".repeat(40);
let dir: string;

/** One Kane run folder under claims/, with a screenshot per step, as runCheck saves it. */
function kaneRun(folder: string, status: "failed" | "passed", steps: { ordinal: number; status: string; image: string }[]) {
  const evidence = steps.map(({ ordinal, status: stepStatus, image }) => {
    const shot = `tests/t-${folder}/steps/${ordinal}-0/screenshot.jpg`;
    const path = join(dir, "check", "claims", folder, "evidence", shot);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, image);
    return { ordinal, kind: "assert", status: stepStatus, summary: `step ${ordinal}`, url: "", screenshot: shot, annotated: null, failureYaml: null };
  });
  return { status, oneLiner: `${folder} ${status}`, outDir: `/elsewhere/runs/x/claims/${folder}`, evidence, steps: [], observations: [] };
}

function saveCheck(followUps: unknown[], candidateFinding = true) {
  const claim = { id: "docs/admin.md#L14", type: "ui_flow", quote: "Click the *Admin* tab.", check: "c", source: { file: "docs/admin.md", startLine: 14, endLine: 14 } };
  const report = {
    runId: "r", target: "my-app", repo: "https://github.com/me/my-app", commit: COMMIT, startedAt: "", finishedAt: "",
    documents: ["docs/admin.md"], claims: [claim], rejected: [], notTested: [], kaneCredits: 0,
    model: { calls: 0, inputTokens: 0, outputTokens: 0, cacheHits: 0 },
    tested: [{
      claim,
      kane: kaneRun("admin_L14", "failed", [{ ordinal: 1, status: "passed", image: "login" }, { ordinal: 2, status: "failed", image: "no tab, run 1" }]),
      questioning: { verdict: "unconfirmed", reason: "Candidate finding.", followUps, ...(candidateFinding ? { candidateFinding: true } : {}) },
    }],
  };
  writeFileSync(join(dir, "check", "check.json"), JSON.stringify(report));
  return join(dir, "check", "check.json");
}

const retry = () => ({ purpose: "retry", reason: "r", kane: kaneRun("admin_L14--retry", "failed", [{ ordinal: 3, status: "failed", image: "no tab, run 2" }]) });
const control = () => ({ purpose: "control", reason: "c", kane: kaneRun("admin_L14--control", "passed", [{ ordinal: 1, status: "passed", image: "settings" }, { ordinal: 4, status: "passed", image: "site admin" }]) });

describe("confirmFinding", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fibcheck-confirm-"));
    mkdirSync(join(dir, "check"));
  });

  it("turns a reviewed candidate into a findings entry that card and attack can use", () => {
    const checkPath = saveCheck([retry(), control()]);
    const findingsPath = join(dir, "out", "findings.json");
    const entry = confirmFinding({
      checkPath, claimId: "docs/admin.md#L14", verdict: "outdated", findingsPath,
      fix: "Select *Admin* from the *Settings* dropdown.", project: "My App",
    });

    expect(entry).toMatchObject({
      id: "my-app-admin-l14", project: "My App", own: false, verdict: "outdated", quote: "Click the *Admin* tab.",
      source: { repo: "https://github.com/me/my-app", commit: COMMIT, file: "docs/admin.md", line: 14 },
      fix: "Select *Admin* from the *Settings* dropdown.", score: { findings: 1, claims: 1 },
      evidence: { failures: ["evidence/my-app-admin-l14-run1.jpg", "evidence/my-app-admin-l14-run2.jpg"], control: "evidence/my-app-admin-l14-control.jpg" },
    });
    // The failed step of each failing run and the last step of the control, copied unchanged.
    const read = (name: string) => readFileSync(join(dir, "out", "evidence", name), "utf8");
    expect(read("my-app-admin-l14-run1.jpg")).toBe("no tab, run 1");
    expect(read("my-app-admin-l14-run2.jpg")).toBe("no tab, run 2");
    expect(read("my-app-admin-l14-control.jpg")).toBe("site admin");
    const [saved] = loadFindings(findingsPath);
    expect(cardText(saved!).stamp).toBe("OUTDATED");
  });

  it("uses the reworded run that showed the contradiction, not a first run that failed for another reason", () => {
    // The first run failed because Kane missed a step; the reworded check failed on the claim, and the
    // repeat run reproduced that reworded check. The evidence is the reworded run and its repeat.
    const reword = { purpose: "reword", reason: "w", kane: kaneRun("admin_L14--reword", "failed", [{ ordinal: 5, status: "failed", image: "no tab, reworded" }]) };
    const checkPath = saveCheck([reword, retry(), control()]);
    const findingsPath = join(dir, "out", "findings.json");
    confirmFinding({ checkPath, claimId: "docs/admin.md#L14", verdict: "outdated", findingsPath, project: "My App" });
    const read = (name: string) => readFileSync(join(dir, "out", "evidence", name), "utf8");
    expect(read("my-app-admin-l14-run1.jpg")).toBe("no tab, reworded");
    expect(read("my-app-admin-l14-run2.jpg")).toBe("no tab, run 2");
  });

  it("refuses when the run that the repeat reproduced did not fail", () => {
    const reword = { purpose: "reword", reason: "w", kane: kaneRun("admin_L14--reword", "passed", [{ ordinal: 5, status: "passed", image: "passed" }]) };
    const checkPath = saveCheck([reword, retry(), control()]);
    expect(() => confirmFinding({ checkPath, claimId: "docs/admin.md#L14", verdict: "outdated", findingsPath: join(dir, "f.json") }))
      .toThrow(/two separate failed Kane runs and a passing control/);
  });

  it("appends to an existing findings file and refuses to overwrite an entry", () => {
    const checkPath = saveCheck([retry(), control()]);
    const findingsPath = join(dir, "findings.json");
    writeFileSync(findingsPath, "[]\n");
    const options = { checkPath, claimId: "docs/admin.md#L14", verdict: "false" as const, findingsPath, id: "admin-tab" };
    confirmFinding(options);
    expect(JSON.parse(readFileSync(findingsPath, "utf8"))).toHaveLength(1);
    expect(() => confirmFinding(options)).toThrow(/already has a finding called admin-tab/);
  });

  it.each([
    ["a claim without two failures and a passing control", () => saveCheck([control()]), /two separate failed Kane runs and a passing control/],
    ["a control that did not pass", () => saveCheck([retry(), { ...control(), kane: { ...control().kane, status: "failed" } }]), /two separate failed Kane runs and a passing control/],
    ["a claim fibcheck did not mark as a candidate", () => saveCheck([retry(), control()], false), /not a candidate finding/],
  ])("refuses %s", (_name, save, message) => {
    const checkPath = save();
    expect(() => confirmFinding({ checkPath, claimId: "docs/admin.md#L14", verdict: "outdated", findingsPath: join(dir, "f.json") })).toThrow(message);
    expect(existsSync(join(dir, "f.json"))).toBe(false);
  });

  it("refuses an unknown claim and a verdict other than false or outdated", () => {
    const checkPath = saveCheck([retry(), control()]);
    const findingsPath = join(dir, "f.json");
    expect(() => confirmFinding({ checkPath, claimId: "docs/admin.md#L99", verdict: "outdated", findingsPath })).toThrow(/was not tested/);
    expect(() => confirmFinding({ checkPath, claimId: "docs/admin.md#L14", verdict: "true" as never, findingsPath })).toThrow(/false or outdated/);
  });
});
