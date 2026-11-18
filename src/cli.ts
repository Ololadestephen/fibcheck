#!/usr/bin/env node
import { existsSync, realpathSync } from "node:fs";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { runCheck } from "./check.js";
import { createModelClient, loadDotEnv } from "./model/config.js";
import { writeReport } from "./report/report.js";
import { loadTarget, loginSecretsFromEnv, targetPathFor } from "./target.js";

export const USAGE = `fibcheck: finds the false claims in a web app's README with Kane CLI.

Usage:
  fibcheck check <target.json | repository> [--max-claims N] [--max-kane-runs N] [--only CLAIM_ID ...]
                 [--url ADDRESS [--login SENTENCE] | --app-running]
  fibcheck report <check.json>
  fibcheck --help

Use sissbruecker/linkding or its GitHub URL for the bundled Linkding target.
A target file names the repository, its docs, and how to run the app (see targets/).
The check command needs Kane CLI (npm install -g @testmuai/kane-cli, then kane-cli login)
and GEMINI_API_KEY in .env. Without --url it also needs Docker, to start the app from the target.
--url checks an app that is already running there, with no Docker. --login replaces the target's
login sentence; write {{NAME}} for a value and put FIBCHECK_LOGIN_NAME=... in .env, for example
--login "Sign in as {{user}} with password {{pass}}." with FIBCHECK_LOGIN_USER and FIBCHECK_LOGIN_PASS.
Claims are ranked by how specific they are (named menus, buttons, settings, defaults and steps).
The top --max-claims (default 5; 5 to 10 is a good range) are tested, and the rest are listed as not tested.
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
    process.stderr.write("Usage: fibcheck report <check.json>\n");
    return 1;
  }
  const { htmlPath, badgePath } = writeReport(inputPath);
  process.stdout.write(`Saved ${htmlPath}\nSaved ${badgePath}\n`);
  return 0;
}

interface CheckArgs {
  target: string;
  maxClaims?: number;
  maxKaneRuns?: number;
  only?: string[];
  appRunning?: boolean;
  url?: string;
  login?: string;
}

/** Parses and validates `check` arguments, returning an error message instead of throwing. */
export function parseCheckArgs(args: string[]): CheckArgs | string {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      "max-claims": { type: "string" },
      "max-kane-runs": { type: "string" },
      only: { type: "string", multiple: true },
      "app-running": { type: "boolean" },
      url: { type: "string" },
      login: { type: "string" },
    },
  });
  const [target] = positionals;
  if (!target || positionals.length !== 1) return `check needs one target file or repository.\n\n${USAGE}`;
  const maxClaims = wholeNumber(values["max-claims"], Number.isInteger);
  if (maxClaims === null) return "--max-claims must be a whole number.\n";
  const maxKaneRuns = wholeNumber(values["max-kane-runs"], Number.isSafeInteger);
  if (maxKaneRuns === null) return "--max-kane-runs must be a whole number.\n";
  if (values.login !== undefined && values.url === undefined) return "--login needs --url.\n";
  if (values.url !== undefined && values["app-running"]) return "Use either --url or --app-running, not both.\n";
  return { target, maxClaims, maxKaneRuns, only: values.only, appRunning: values["app-running"], url: values.url, login: values.login };
}

/** undefined when absent, null when not a non-negative whole number. */
function wholeNumber(raw: string | undefined, isWhole: (value: number) => boolean): number | undefined | null {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return isWhole(value) && value >= 0 ? value : null;
}

async function check(args: string[]): Promise<number> {
  const parsed = parseCheckArgs(args);
  if (typeof parsed === "string") {
    process.stderr.write(parsed);
    return 1;
  }
  const targetPath = targetPathFor(parsed.target);
  loadDotEnv();
  const alreadyRunning = parsed.url !== undefined || parsed.appRunning === true;
  const login = parsed.login ?? loadTarget(targetPath).login;
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const report = await runCheck(createModelClient(runId), {
    targetPath,
    maxClaims: parsed.maxClaims,
    maxKaneRuns: parsed.maxKaneRuns,
    only: parsed.only,
    appRunning: parsed.appRunning,
    appUrl: parsed.url,
    login: parsed.login,
    appRunningSecrets: alreadyRunning ? loginSecretsFromEnv(login) : undefined,
    log: (line) => process.stdout.write(`${line}\n`),
  });
  process.stdout.write(summaryLine(report));
  return 0;
}

function summaryLine(report: Awaited<ReturnType<typeof runCheck>>): string {
  const counts = report.tested.reduce<Record<string, number>>((acc, t) => ((acc[t.kane.status] = (acc[t.kane.status] ?? 0) + 1), acc), {});
  const results = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ") || "none";
  const models = report.model.models?.length ? ` (${report.model.models.join(", ")})` : "";
  return `\nTested ${report.tested.length} claim(s). Initial Kane results: ${results}. ` +
    `Not tested: ${report.notTested.length}. Kane credits: ${report.kaneCredits.toFixed(1)}. Model calls: ${report.model.calls}${models}.\n`;
}

const executable = process.argv[1];
if (executable && existsSync(executable) && import.meta.url === pathToFileURL(realpathSync(executable)).href) {
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (error: unknown) => {
      process.stderr.write(`fibcheck: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
