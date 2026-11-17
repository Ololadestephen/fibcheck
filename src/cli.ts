#!/usr/bin/env node
import { existsSync, realpathSync } from "node:fs";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { runCheck } from "./check.js";
import { createModelClient, loadDotEnv } from "./model/config.js";
import { writeReport } from "./report/report.js";
import { targetPathFor } from "./target.js";

export const USAGE = `pinocchio: finds the false claims in a web app's README with Kane CLI.

Usage:
  pinocchio check <target.json | repository> [--max-claims N] [--max-kane-runs N] [--only CLAIM_ID ...] [--app-running]
  pinocchio report <check.json>
  pinocchio --help

Use sissbruecker/linkding or its GitHub URL for the bundled Linkding target.
A target file names the repository, its docs, and how to run the app (see targets/).
The check command needs Kane CLI (npm install -g @testmuai/kane-cli, then kane-cli login),
Docker, and GEMINI_API_KEY in .env.
The report command writes report.html and badge.svg beside a saved check.json.
`;

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (command === "check") return await check(rest);
  if (command === "report") return report(rest);
  process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
  return 1;
}

function report(args: string[]): number {
  const [inputPath] = args;
  if (args.length !== 1 || !inputPath || inputPath.startsWith("-")) {
    process.stderr.write("Usage: pinocchio report <check.json>\n");
    return 1;
  }
  const { htmlPath, badgePath } = writeReport(inputPath);
  process.stdout.write(`Saved ${htmlPath}\nSaved ${badgePath}\n`);
  return 0;
}

async function check(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      "max-claims": { type: "string" },
      "max-kane-runs": { type: "string" },
      only: { type: "string", multiple: true },
      "app-running": { type: "boolean" },
    },
  });
  const [target] = positionals;
  if (!target || positionals.length !== 1) {
    process.stderr.write(`check needs one target file or repository.\n\n${USAGE}`);
    return 1;
  }
  const maxClaims = values["max-claims"] === undefined ? undefined : Number(values["max-claims"]);
  if (maxClaims !== undefined && (!Number.isInteger(maxClaims) || maxClaims < 0)) {
    process.stderr.write("--max-claims must be a whole number.\n");
    return 1;
  }
  const maxKaneRuns = values["max-kane-runs"] === undefined ? undefined : Number(values["max-kane-runs"]);
  if (maxKaneRuns !== undefined && (!Number.isSafeInteger(maxKaneRuns) || maxKaneRuns < 0)) {
    process.stderr.write("--max-kane-runs must be a whole number.\n");
    return 1;
  }
  const targetPath = targetPathFor(target);
  loadDotEnv();
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const client = createModelClient(runId);
  const report = await runCheck(client, {
    targetPath,
    maxClaims,
    maxKaneRuns,
    only: values.only,
    appRunning: values["app-running"],
    log: (line) => process.stdout.write(`${line}\n`),
  });
  const counts = report.tested.reduce<Record<string, number>>((acc, t) => ((acc[t.kane.status] = (acc[t.kane.status] ?? 0) + 1), acc), {});
  process.stdout.write(
    `\nTested ${report.tested.length} claim(s). Initial Kane results: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ") || "none"}. ` +
      `Not tested: ${report.notTested.length}. Kane credits: ${report.kaneCredits.toFixed(1)}. Model calls: ${report.model.calls}.\n`,
  );
  return 0;
}

const executable = process.argv[1];
if (executable && existsSync(executable) && import.meta.url === pathToFileURL(realpathSync(executable)).href) {
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (error: unknown) => {
      process.stderr.write(`pinocchio: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
