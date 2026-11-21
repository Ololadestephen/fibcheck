import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extractStepEvidence, findEvidencePack, type StepEvidence } from "./evidence.js";
import { parseKaneOutput, type KaneResult } from "./parse.js";
import { errorMessage } from "../util.js";

export type AssertionMode = "dom" | "visual";

export interface KaneRunOptions {
  /** The natural-language flow for Kane. Use {{name}} for variables. */
  objective: string;
  startUrl: string;
  /** Folder for this run's raw output and evidence. Created if missing. */
  outDir: string;
  maxSteps?: number;
  timeoutSec?: number;
  assertionMode?: AssertionMode;
  /** Kane variables file (may hold secret test logins; never logged). */
  variablesFile?: string;
  /** The command to run; tests pass a fake. */
  command?: string;
  argsPrefix?: string[];
}

export interface KaneRun extends KaneResult {
  objective: string;
  startUrl: string;
  outDir: string;
  /** Step screenshots copied out of Kane's evidence pack. Empty if the pack was missing. */
  evidence: StepEvidence[];
  evidenceError: string | null;
}

/** Runs one Kane flow in agent mode and returns its structured result. Only Kane decides pass or fail. */
export async function runKane(options: KaneRunOptions): Promise<KaneRun> {
  mkdirSync(options.outDir, { recursive: true });
  const { stdout, stderr, exitCode } = await run(options.command ?? "kane-cli", kaneArgs(options));
  writeFileSync(join(options.outDir, "kane.ndjson"), stdout);
  writeFileSync(join(options.outDir, "kane.stderr"), stderr);

  const result = parseKaneOutput(stdout, exitCode);
  const { evidence, evidenceError } = collectEvidence(result, options.outDir);
  const kaneRun: KaneRun = { ...result, objective: options.objective, startUrl: options.startUrl, outDir: options.outDir, evidence, evidenceError };
  writeFileSync(join(options.outDir, "result.json"), `${JSON.stringify(kaneRun, null, 2)}\n`);
  return kaneRun;
}

function kaneArgs(options: KaneRunOptions): string[] {
  return [
    ...(options.argsPrefix ?? []),
    "run",
    options.objective,
    "--url",
    options.startUrl,
    "--agent",
    "--headless",
    "--max-steps",
    String(options.maxSteps ?? 25),
    "--timeout",
    String(options.timeoutSec ?? 420),
    ...(options.assertionMode ? ["--assertion-mode", options.assertionMode] : []),
    ...(options.variablesFile ? ["--variables-file", options.variablesFile] : []),
  ];
}

function collectEvidence(result: KaneResult, outDir: string): { evidence: StepEvidence[]; evidenceError: string | null } {
  const pack = findEvidencePack(result.evidencePack, result.sessionDir);
  if (!pack) {
    const expected = result.status === "passed" || result.status === "failed";
    return { evidence: [], evidenceError: expected ? "Kane's evidence pack was not found." : null };
  }
  try {
    return { evidence: extractStepEvidence(pack, join(outDir, "evidence")), evidenceError: null };
  } catch (error) {
    return { evidence: [], evidenceError: `Could not unpack Kane's evidence: ${errorMessage(error)}` };
  }
}

function run(command: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", (error) =>
      reject(new Error(`Could not start ${command}: ${error.message}. Install Kane CLI with: npm install -g @testmuai/kane-cli`)),
    );
    child.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
  });
}
