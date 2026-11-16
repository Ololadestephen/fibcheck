#!/usr/bin/env node
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { runCheck } from "./check.js";
import { createModelClient, loadDotEnv } from "./model/config.js";

export const USAGE = `pinocchio: finds the false claims in a web app's README with Kane CLI.

Usage:
  pinocchio check <target.json> [--max-claims N] [--only CLAIM_ID ...] [--app-running]
  pinocchio --help

A target file names the repository, its docs, and how to run the app (see targets/).
Needs Kane CLI (npm install -g @testmuai/kane-cli, then kane-cli login),
Docker, and GEMINI_API_KEY in .env.
`;

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (command === "check") return await check(rest);
  process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
  return 1;
}

async function check(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      "max-claims": { type: "string" },
      only: { type: "string", multiple: true },
      "app-running": { type: "boolean" },
    },
  });
  const targetPath = positionals[0];
  if (!targetPath) {
    process.stderr.write(`check needs a target file.\n\n${USAGE}`);
    return 1;
  }
  const maxClaims = values["max-claims"] === undefined ? undefined : Number(values["max-claims"]);
  if (maxClaims !== undefined && (!Number.isInteger(maxClaims) || maxClaims < 0)) {
    process.stderr.write("--max-claims must be a whole number.\n");
    return 1;
  }
  loadDotEnv();
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const client = createModelClient(runId);
  const report = await runCheck(client, {
    targetPath,
    maxClaims,
    only: values.only,
    appRunning: values["app-running"],
    log: (line) => process.stdout.write(`${line}\n`),
  });
  const counts = report.tested.reduce<Record<string, number>>((acc, t) => ((acc[t.kane.status] = (acc[t.kane.status] ?? 0) + 1), acc), {});
  process.stdout.write(
    `\nTested ${report.tested.length} claim(s): ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ") || "none"}. ` +
      `Not tested: ${report.notTested.length}. Kane credits: ${report.kaneCredits.toFixed(1)}. Model calls: ${report.model.calls}.\n` +
      "Kane's pass or fail is not yet a verdict: the questioning loop (T4) decides true, false, outdated or unconfirmed.\n",
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (error: unknown) => {
      process.stderr.write(`pinocchio: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
