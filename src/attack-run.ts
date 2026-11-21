import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { lazyFixTally, runAttack, type AttemptResult, type LazyFix } from "./attack.js";
import { loadFindings } from "./card.js";
import { modelDiagnoser } from "./diagnose.js";
import { readFindingsFile, writeFindingsFile, type Finding } from "./findings.js";
import { escapeKaneBraces, localAddressesToApp, writeKaneVariables } from "./kane/objective.js";
import { runKane } from "./kane/runner.js";
import type { ModelClient } from "./model/client.js";
import { appBaseUrl, runningAppVariables } from "./target.js";

export interface AttackOptions {
  findingsPath: string;
  id: string;
  /** The running app the lazy fixes are checked against. */
  appUrl: string;
  /** How Kane signs in, with {{NAME}} values. */
  login?: string;
  secrets?: Readonly<Record<string, string>>;
  /** Where Kane's run folders go. */
  runsDir: string;
  log?: (line: string) => void;
}

export interface AttackRecord {
  id: string;
  at: string;
  original: string;
  fix: string;
  appUrl: string;
  results: AttemptResult[];
}

/** The Kane objective for one lazy fix: sign in, show the proposed docs line, then its check. */
export function attackObjective(login: string | undefined, attempt: LazyFix): string {
  return [login, `Proposed documentation says: "${escapeKaneBraces(attempt.text)}".`, escapeKaneBraces(localAddressesToApp(attempt.check ?? ""))].filter(Boolean).join(" ");
}

/**
 * Runs the lazy-fix attack for one recorded finding, saves every attempt to
 * index/attacks/<id>.json, and records the rejected count on the finding.
 */
export async function attackFinding(client: ModelClient, options: AttackOptions): Promise<AttackRecord> {
  appBaseUrl(options.appUrl);
  const log = options.log ?? (() => {});
  const finding = loadFindings(options.findingsPath).find(({ id }) => id === options.id);
  if (!finding) throw new Error(`No finding called ${options.id} in ${options.findingsPath}.`);
  if (finding.verdict !== "false" && finding.verdict !== "outdated") throw new Error(`Finding ${finding.id} is ${finding.verdict}; only false or outdated findings get a lazy-fix attack.`);
  if (!finding.fix) throw new Error(`Finding ${finding.id} has no proven fix recorded.`);
  const fix = finding.fix;
  const variables = runningAppVariables(options.login, options.secrets ?? {});
  const diagnose = modelDiagnoser(client, [...Object.values(variables).map(({ value }) => value), new URL(options.appUrl).host]);
  const variablesFile = writeKaneVariables(variables);
  try {
    let index = 0;
    const results = await runAttack(client, { original: finding.quote, fix, file: finding.source.file }, async (attempt) => {
      index++;
      log(`  Kane checks the ${attempt.kind} attempt: "${attempt.text}"`);
      return await runKane({
        objective: attackObjective(options.login, attempt),
        startUrl: options.appUrl,
        outDir: join(options.runsDir, `${finding.id}-${attempt.kind}-${index}`),
        variablesFile: variablesFile?.path,
      });
    }, async (attempt, kane) => {
      const claim = { id: `${finding.id}-${attempt.kind}`, type: "ui_flow" as const, quote: attempt.text, source: { file: finding.source.file, startLine: finding.source.line, endLine: finding.source.line } };
      return await diagnose(claim, attempt.check ?? "", kane);
    });
    const record: AttackRecord = { id: finding.id, at: new Date().toISOString(), original: finding.quote, fix, appUrl: options.appUrl, results };
    saveAttack(options.findingsPath, finding, record);
    return record;
  } finally {
    variablesFile?.remove();
  }
}

function saveAttack(findingsPath: string, finding: Finding, record: AttackRecord): void {
  const dir = join(dirname(findingsPath), "attacks");
  mkdirSync(dir, { recursive: true });
  const portable = { ...record, results: record.results.map(({ kane, ...rest }) => (kane ? { ...rest, kane: { status: kane.status, oneLiner: kane.oneLiner } } : rest)) };
  writeFileSync(join(dir, `${finding.id}.json`), `${JSON.stringify(portable, null, 2)}\n`);
  const all = readFindingsFile(findingsPath);
  const lazyFixes = lazyFixTally(record.results);
  const updated = all.map((entry) => (entry.id === finding.id ? { ...entry, lazyFixes } : entry));
  writeFindingsFile(findingsPath, updated);
}
