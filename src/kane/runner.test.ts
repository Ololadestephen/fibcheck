import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runKane } from "./runner.js";

/** Builds a small evidence pack shaped like Kane's: tests/<id>/steps/<n>-0-<n>/... */
function makePack(dir: string): string {
  const root = join(dir, "pack");
  const step = (n: number, status: string, failure = false) => {
    const d = join(root, "tests", "t1", "steps", `${n}-0-${n}`);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "step.json"), JSON.stringify({ kind: "analyze", status, summary: `step ${n}`, url: "http://localhost/x", ordinal: n }));
    writeFileSync(join(d, "screenshot.jpg"), "jpg");
    if (failure) writeFileSync(join(d, "failure.yaml"), "status: broken\n");
  };
  step(10, "failed", true);
  step(2, "passed");
  const pack = join(dir, "run.evidence");
  execFileSync("zip", ["-q", "-r", pack, "tests"], { cwd: root });
  return pack;
}

/** A stand-in for kane-cli: prints the given lines and exits with the given code. */
function fakeKane(dir: string, lines: unknown[], exitCode: number): { command: string; argsPrefix: string[] } {
  const script = join(dir, "fake-kane.mjs");
  writeFileSync(script, `process.stdout.write(${JSON.stringify(lines.map((l) => JSON.stringify(l)).join("\n") + "\n")}); process.stderr.write("args:" + JSON.stringify(process.argv.slice(2))); process.exit(${exitCode});`);
  return { command: process.execPath, argsPrefix: [script] };
}

describe("runKane", () => {
  it("runs Kane, saves raw output and unpacks step screenshots in order", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pino-kane-"));
    const pack = makePack(dir);
    const fake = fakeKane(
      dir,
      [
        { type: "stream_start" },
        { step: 2, status: "done", remark: "navigate" },
        { step: 10, status: "failed", remark: "assert: Admin tab" },
        { type: "coverage", pack },
        { type: "run_end", status: "failed", reason: "Final verification failed", credits_consumed: 30.5, verdict: { family: "automation_bug", category: "test_data_issue", root_cause: "x", confidence: 0.9 } },
      ],
      1,
    );
    const outDir = join(dir, "out");
    const run = await runKane({ objective: "Check {{thing}}", startUrl: "http://localhost:9090/", outDir, variablesFile: "/tmp/vars.json", ...fake });

    expect(run.status).toBe("failed");
    expect(run.credits).toBe(30.5);
    expect(run.evidence.map((e) => [e.ordinal, e.status, e.failureYaml !== null])).toEqual([
      [2, "passed", false],
      [10, "failed", true],
    ]);
    expect(existsSync(join(outDir, "evidence", run.evidence[1]?.screenshot ?? "missing"))).toBe(true);
    expect(readFileSync(join(outDir, "kane.ndjson"), "utf8")).toContain("run_end");
    const args = JSON.parse(readFileSync(join(outDir, "kane.stderr"), "utf8").replace("args:", "")) as string[];
    expect(args).toEqual(expect.arrayContaining(["run", "Check {{thing}}", "--agent", "--headless", "--variables-file", "/tmp/vars.json"]));
    expect(JSON.parse(readFileSync(join(outDir, "result.json"), "utf8")).status).toBe("failed");
  });

  it("reports a missing evidence pack without failing the run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pino-kane-"));
    const fake = fakeKane(dir, [{ type: "run_end", status: "passed" }], 0);
    const run = await runKane({ objective: "o", startUrl: "http://x", outDir: join(dir, "out"), ...fake });
    expect(run.status).toBe("passed");
    expect(run.evidenceError).toMatch(/not found/);
  });

  it("explains how to install Kane when the command is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pino-kane-"));
    await expect(runKane({ objective: "o", startUrl: "http://x", outDir: dir, command: "kane-cli-does-not-exist" })).rejects.toThrow(/npm install -g @testmuai\/kane-cli/);
  });
});
