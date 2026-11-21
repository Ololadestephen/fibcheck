#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { attackFinding } from "./attack-run.js";
import { attackSummary } from "./attack.js";
import { cardCommand } from "./card/command.js";
import { runCheck } from "./check.js";
import { extractClaims } from "./claims/extract.js";
import { confirmFinding } from "./confirm.js";
import { freeze, frozenClaims } from "./frozen.js";
import { createModelClient, loadDotEnv } from "./model/config.js";
import { writeReport } from "./report/report.js";
import { loadTarget, loginSecretsFromEnv, targetPathFor } from "./target.js";
import { errorMessage, newRunId } from "./util.js";

export const USAGE = `fibcheck: finds the false claims in a web app's README with Kane CLI.

Usage:
  fibcheck check <target.json | repository> [--max-claims N] [--max-kane-runs N] [--only CLAIM_ID ...]
                 [--url ADDRESS [--login SENTENCE] | --app-running]
  fibcheck report <check.json>
  fibcheck card <finding-id | --all> [--findings index/findings.json] [--out index/cards] [--animate]
  fibcheck attack <finding-id> --url ADDRESS [--login SENTENCE] [--findings index/findings.json]
  fibcheck confirm <check.json> <claim-id> --verdict false|outdated [--fix SENTENCE] [--project NAME] [--own]
                   [--id ID] [--findings index/findings.json]
  fibcheck freeze <docs.md> --out <claims.json>
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
The card command draws a PNG share card for a recorded finding, from its verdict and Kane screenshot only.
--animate also writes an animated GIF of the card beside the PNG.
The attack command tries lazy fixes for a finding (delete the line, make it vague, hedge it, or guess a
wrong detail) against the app at --url; each must be rejected by rule or failed by Kane.
The confirm command records a candidate finding you have reviewed (two failed Kane runs and a passing
control) in a findings file, with copies of Kane's screenshots, so card and attack can use it. Pass --fix
with the corrected sentence that a fresh Kane run passed; attack needs it.
The freeze command writes the browser checks for a docs file (path relative to the repository root) once,
for a person to review. Fill in "reviewed" for each claim you approve and commit the file; the GitHub Action's
claims-file input then reruns exactly those checks. Editing a check afterwards needs a fresh freeze and review.
`;

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (command === "check") return await checkCommand(rest);
  if (command === "report") return reportCommand(rest);
  if (command === "card") return cardCommand(rest);
  if (command === "attack") return await attackCommand(rest);
  if (command === "freeze") return await freezeCommand(rest);
  if (command === "confirm") return confirmCommand(rest);
  process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
  return 1;
}

function confirmCommand(args: string[]): number {
  const { values, positionals } = parseArgs({
    args, allowPositionals: true,
    options: {
      verdict: { type: "string" }, fix: { type: "string" }, project: { type: "string" },
      own: { type: "boolean" }, id: { type: "string" }, findings: { type: "string" },
    },
  });
  const [checkPath, claimId] = positionals;
  if (!checkPath || !claimId || positionals.length !== 2 || (values.verdict !== "false" && values.verdict !== "outdated")) {
    process.stderr.write("Usage: fibcheck confirm <check.json> <claim-id> --verdict false|outdated [--fix SENTENCE] [--project NAME] [--own] [--id ID] [--findings index/findings.json]\n");
    return 1;
  }
  const findingsPath = values.findings ?? "index/findings.json";
  const finding = confirmFinding({
    checkPath, claimId, verdict: values.verdict, findingsPath,
    fix: values.fix, project: values.project, own: values.own, id: values.id,
  });
  process.stdout.write(`Added ${finding.id} to ${findingsPath} with ${finding.evidence.failures.length} failed runs and a control.\n`);
  if (!finding.fix) process.stdout.write("No --fix was given, so attack cannot run on it yet.\n");
  return 0;
}

async function freezeCommand(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { out: { type: "string" } } });
  const [docsFile] = positionals;
  if (!docsFile || !values.out || positionals.length !== 1) {
    process.stderr.write("Usage: fibcheck freeze <docs.md> --out <claims.json>\n");
    return 1;
  }
  loadDotEnv();
  const runId = newRunId();
  const extraction = await extractClaims(createModelClient(runId), [{ file: docsFile, content: readFileSync(docsFile, "utf8") }]);
  const file = freeze(docsFile, extraction.claims);
  writeFileSync(values.out, `${JSON.stringify(file, null, 2)}\n`, { flag: "wx" });
  const { needsReview } = frozenClaims({ ...file, claims: file.claims.map((claim) => ({ ...claim, reviewed: { by: "check", at: "check" } })) });
  process.stdout.write(`Wrote ${file.claims.length} check(s) to ${values.out} for review. None will run until "reviewed" is filled in.\n`);
  for (const { line, why } of needsReview) process.stdout.write(`  Line ${line}: ${why}\n`);
  return 0;
}

async function attackCommand(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args, allowPositionals: true,
    options: { url: { type: "string" }, login: { type: "string" }, findings: { type: "string" } },
  });
  const [id] = positionals;
  if (!id || !values.url) {
    process.stderr.write("Usage: fibcheck attack <finding-id> --url ADDRESS [--login SENTENCE] [--findings index/findings.json]\n");
    return 1;
  }
  const loginError = loginArgError(values.login);
  if (loginError) {
    process.stderr.write(loginError);
    return 1;
  }
  loadDotEnv();
  const runId = newRunId();
  const record = await attackFinding(createModelClient(runId), {
    findingsPath: values.findings ?? "index/findings.json", id, appUrl: values.url, login: values.login,
    secrets: loginSecretsFromEnv(values.login), runsDir: join("runs", `attack-${runId}`),
    log: (line) => process.stdout.write(`${line}\n`),
  });
  for (const result of record.results) process.stdout.write(`${result.kind}: ${result.outcome}. ${result.reason}\n`);
  process.stdout.write(`${attackSummary(record.results) || "No lazy fix was rejected."}\n`);
  return 0;
}

function reportCommand(args: string[]): number {
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
  const loginError = loginArgError(values.login);
  if (loginError) return loginError;
  if (values.url !== undefined && values["app-running"]) return "Use either --url or --app-running, not both.\n";
  return { target, maxClaims, maxKaneRuns, only: values.only, appRunning: values["app-running"], url: values.url, login: values.login };
}

function loginArgError(login: string | undefined): string | undefined {
  if (login !== undefined && !/\{\{[A-Za-z_][A-Za-z0-9_]*\}\}/.test(login)) {
    return "--login must name its values as {{NAME}} and keep them in .env as FIBCHECK_LOGIN_NAME, never type a password into the command.\n";
  }
  return undefined;
}

/** undefined when absent, null when not a non-negative whole number. */
function wholeNumber(raw: string | undefined, isWhole: (value: number) => boolean): number | undefined | null {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return isWhole(value) && value >= 0 ? value : null;
}

async function checkCommand(args: string[]): Promise<number> {
  const parsed = parseCheckArgs(args);
  if (typeof parsed === "string") {
    process.stderr.write(parsed);
    return 1;
  }
  const targetPath = targetPathFor(parsed.target);
  loadDotEnv();
  const alreadyRunning = parsed.url !== undefined || parsed.appRunning === true;
  const login = parsed.login ?? loadTarget(targetPath).login;
  const runId = newRunId();
  const report = await runCheck(createModelClient(runId), {
    targetPath,
    runId,
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
      process.stderr.write(`fibcheck: ${errorMessage(error)}\n`);
      process.exitCode = 1;
    },
  );
}
