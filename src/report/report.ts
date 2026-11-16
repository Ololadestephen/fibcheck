import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { CheckReport, ClaimRun } from "../check.js";
import type { Claim } from "../claims/types.js";
import type { KaneRun } from "../kane/runner.js";
import type { ClaimVerdict } from "../loop.js";

export function writeReport(inputPath: string): { htmlPath: string; badgePath: string } {
  const directory = dirname(resolve(inputPath));
  const htmlPath = join(directory, "report.html");
  const badgePath = join(directory, "badge.svg");
  if ([htmlPath, badgePath].includes(resolve(inputPath))) {
    throw new Error("Choose the check JSON as input. report.html and badge.svg are output files.");
  }

  let html: string;
  let badge: string;
  try {
    const report = JSON.parse(readFileSync(inputPath, "utf8")) as CheckReport;
    if (!Array.isArray(report?.claims) || !Array.isArray(report.tested) || !Array.isArray(report.notTested)) {
      throw new Error("Expected a saved Pinocchio check with claims and Kane results.");
    }
    const counts = countResults(report);
    const artwork = renderBadge(counts);
    html = renderReport(report, counts, artwork, directory, basename(inputPath));
    badge = artwork.svg;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read check report at ${inputPath}: ${message}`);
  }
  writeFileSync(badgePath, badge);
  writeFileSync(htmlPath, html);
  return { htmlPath, badgePath };
}

const RESULT_LABELS = {
  passed: "Kane passed",
  failed: "Kane failed",
  error: "Kane error",
  cancelled: "Kane cancelled",
} satisfies Record<KaneRun["status"], string>;

const VERDICT_LABELS = {
  true: "True",
  false: "False",
  outdated: "Outdated",
  unconfirmed: "Unconfirmed",
} satisfies Record<ClaimVerdict, string>;

function runByClaim(report: CheckReport): Map<string, ClaimRun> {
  return new Map(report.tested.map((entry) => [entry.claim.id, entry]));
}

function countResults(report: CheckReport) {
  const runs = runByClaim(report);
  const skipped = new Set(report.notTested);
  const counts = {
    tested: runs.size, passed: 0, failed: 0, error: 0, cancelled: 0, skipped: 0, untestable: 0, withoutVerdict: 0, verifiedPasses: 0,
    verdicts: { true: 0, false: 0, outdated: 0, unconfirmed: 0 } satisfies Record<ClaimVerdict, number>,
  };
  for (const { kane, questioning } of runs.values()) {
    if (!Object.hasOwn(RESULT_LABELS, kane.status)) throw new Error("Unknown Kane result status.");
    counts[kane.status]++;
    if (questioning) {
      if (!Object.hasOwn(VERDICT_LABELS, questioning.verdict)) throw new Error("Unknown claim verdict.");
      counts.verdicts[questioning.verdict]++;
      if (questioning.verdict === "true" && kane.status === "passed" && kane.exitCode === 0) counts.verifiedPasses++;
    } else {
      counts.withoutVerdict++;
    }
  }
  for (const claim of report.claims) {
    if (runs.has(claim.id)) continue;
    if (skipped.has(claim.id)) counts.skipped++;
    else counts.untestable++;
  }
  return counts;
}

type ResultCounts = ReturnType<typeof countResults>;

function renderReport(report: CheckReport, counts: ResultCounts, badge: ReturnType<typeof renderBadge>, directory: string, inputName: string): string {
  const runs = runByClaim(report);
  const skipped = new Set(report.notTested);
  const tested = report.claims.filter((claim) => runs.has(claim.id));
  const remaining = report.claims.filter((claim) => !runs.has(claim.id));
  const name = escapeHtml(report.target);
  const questioned = counts.withoutVerdict < counts.tested;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'self' file:">
<title>${name} · Pinocchio</title>
<style>${REPORT_STYLE}</style>
</head>
<body>
<main>
  <header>
    <img src="badge.svg" alt="Pinocchio · ${escapeHtml(badge.label)}" width="${badge.width}" height="34">
    <h1>${name}</h1>
    <p class="meta">${escapeHtml(report.repo)}${report.commit ? ` · <code>${escapeHtml(report.commit.slice(0, 12))}</code>` : ""}</p>
    <p class="meta">Run <time datetime="${escapeHtml(report.startedAt)}">${escapeHtml(report.startedAt)}</time> · ${report.kaneCredits.toFixed(1)} Kane credits reported · <a href="${encodeURIComponent(inputName)}">Check JSON</a></p>
  </header>
  ${questioned ? renderVerdictScore(counts) : ""}
  <section aria-labelledby="results">
    <h2 id="results">${questioned ? "Initial Kane results" : "Kane results"}</h2>
    ${questioned ? "" : "<p>These results describe individual browser checks. Claim verdicts require the questioning loop.</p>"}
    ${renderKaneCounts(counts, questioned)}
    <p class="meta">${report.claims.length} ${report.claims.length === 1 ? "claim" : "claims"} across ${report.documents.length} ${report.documents.length === 1 ? "document" : "documents"} · ${report.rejected.length} rejected quotes</p>
  </section>
  <section aria-labelledby="tested">
    <h2 id="tested">Tested claims</h2>
    ${tested.map((claim) => renderClaim(claim, runs.get(claim.id), false, directory)).join("\n") || "<p>No Kane runs in this check.</p>"}
  </section>
  <section aria-labelledby="remaining">
    <h2 id="remaining">Remaining claims</h2>
    ${remaining.map((claim) => renderClaim(claim, undefined, skipped.has(claim.id), directory)).join("\n") || "<p>All extracted claims were run.</p>"}
  </section>
</main>
</body>
</html>
`;
}

function renderKaneCounts(counts: ResultCounts, questioned: boolean): string {
  const initial = [
    ...Object.entries(RESULT_LABELS).map(([status, label]) => [label, counts[status as KaneRun["status"]]] as const),
  ];
  return questioned ? renderMetrics(initial) : renderMetrics([
    ["Tested", counts.tested], ...initial, ["Not run", counts.skipped], ["Untestable", counts.untestable],
  ]);
}

function renderVerdictScore(counts: ResultCounts): string {
  const metrics: (readonly [string, number])[] = [
    ["Tested", counts.tested],
    ...Object.entries(VERDICT_LABELS).map(([verdict, label]) => [label, counts.verdicts[verdict as ClaimVerdict]] as const),
    ["Not run", counts.skipped], ["Untestable", counts.untestable],
  ];
  if (counts.withoutVerdict) metrics.push(["Without verdict", counts.withoutVerdict]);
  return `<section aria-labelledby="score">
    <h2 id="score">Pinocchio score</h2>
    ${renderMetrics(metrics)}
  </section>`;
}

function renderMetrics(metrics: (readonly [string, number])[]): string {
  return `<dl class="metrics">${metrics.map(([label, count]) => `<div><dt>${label}</dt><dd>${count}</dd></div>`).join("")}</dl>`;
}

function renderClaim(claim: Claim, entry: ClaimRun | undefined, skipped: boolean, directory: string): string {
  const { file, startLine, endLine } = claim.source;
  const line = startLine === endLine ? `line ${startLine}` : `lines ${startLine}–${endLine}`;
  const question = entry?.questioning;
  const status = question ? `Verdict ${question.verdict}` : entry ? RESULT_LABELS[entry.kane.status] : skipped ? "Not run" : "Untestable";
  return `<article>
    <div class="claim-meta"><span class="status ${question ? "pending" : entry?.kane.status ?? "pending"}">${escapeHtml(status)}</span>
    <span class="meta">${escapeHtml(file)} · ${escapeHtml(line)}</span></div>
    <blockquote>${escapeHtml(claim.quote)}</blockquote>
    ${entry ? renderClaimRuns(entry, directory) : claim.reason ? `<p class="meta">${escapeHtml(claim.reason)}</p>` : ""}
  </article>`;
}

function renderClaimRuns({ kane, questioning }: ClaimRun, directory: string): string {
  if (!questioning) return renderRun(kane, directory);
  const rounds = [{ purpose: "initial", reason: questioning.initialReason, kane }, ...questioning.followUps];
  const roundNames: Record<string, string> = { initial: "Initial check", retry: "Reproduction", control: "Control" };
  const roundsHtml = rounds.map((round) => `<section class="round">
    <h3>${roundNames[round.purpose]} · ${RESULT_LABELS[round.kane.status]}</h3>
    <p class="meta">${escapeHtml(round.reason)}</p>
    ${renderRun(round.kane, directory)}
    ${questioning.overrides.filter((entry) => entry.round === round.purpose).map((entry) => (
      `<p class="override"><strong>Blame override</strong> · Kane reported ${escapeHtml(entry.family)} / ${escapeHtml(entry.category)}. ${escapeHtml(entry.hypothesis)} ${escapeHtml(entry.evidence)}</p>`
    )).join("")}
  </section>`).join("\n");
  return `<p>${escapeHtml(questioning.reason)}</p>${roundsHtml}`;
}

function renderRun(kane: KaneRun, directory: string): string {
  const message = kane.oneLiner || kane.reason;
  const steps = kane.evidence.map((step) => {
    const screenshot = evidenceLink(directory, kane, step.screenshot);
    const annotated = evidenceLink(directory, kane, step.annotated);
    const links = [
      screenshot && `<a href="${screenshot}">Screenshot</a>`,
      annotated && `<a href="${annotated}">Annotated screenshot</a>`,
    ].filter(Boolean);
    const description = step.summary || step.kind;
    return `<li>Step ${escapeHtml(String(step.ordinal))}${description ? ` · ${escapeHtml(description)}` : ""}<span>${links.join(" · ") || "Screenshot unavailable"}</span></li>`;
  });
  return `${message ? `<p>${escapeHtml(message)}</p>` : ""}
    ${kane.failedStep?.remark && kane.failedStep.remark !== message ? `<p class="meta">Failed step ${escapeHtml(String(kane.failedStep.step))} · ${escapeHtml(kane.failedStep.remark)}</p>` : ""}
    ${steps.length ? `<details><summary>Step evidence (${steps.length})</summary><ul>${steps.join("")}</ul></details>` : "<p class=\"meta\">No step screenshots were collected.</p>"}`;
}

function evidenceLink(directory: string, kane: KaneRun, path: string | null): string | undefined {
  if (!path || isAbsolute(path)) return undefined;
  // Kane saves an absolute outDir. The claim folder and the evidence paths stay
  // relative to the saved check so a copied run can still be opened.
  const root = resolve(directory, "claims", basename(kane.outDir), "evidence");
  const file = resolve(root, path);
  const insideEvidence = relative(root, file);
  if (!insideEvidence || insideEvidence === ".." || insideEvidence.startsWith(`..${sep}`) || !existsSync(file)) return undefined;
  return relative(directory, file).split(sep).map(encodeURIComponent).join("/");
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function renderBadge({ tested, verifiedPasses, verdicts }: ResultCounts) {
  const findings = verdicts.false + verdicts.outdated;
  const verified = tested > 0 && verifiedPasses === tested;
  let label = `${tested} claim${tested === 1 ? "" : "s"} tested by Kane`;
  if (verified) label = `Kane swore it's true · ${tested} tested`;
  if (findings) label = `${findings} confirmed finding${findings === 1 ? "" : "s"}`;

  const growth = Math.min(findings, 10) * 5;
  const nose = 13 + growth;
  const divider = 119 + growth;
  const labelWidth = verified ? 225 : 162;
  const width = divider + labelWidth;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="34" viewBox="0 0 ${width} 34" role="img" aria-labelledby="badge-title">
  <title id="badge-title">Pinocchio · ${escapeHtml(label)}</title>
  <rect width="${width}" height="34" rx="6" fill="#233f33"/>
  <path d="M${divider} 0h${labelWidth - 6}a6 6 0 0 1 6 6v22a6 6 0 0 1-6 6H${divider}Z" fill="${verified ? "#dce9dd" : "#eee5d4"}"/>
  <path d="M12 10h11v6l${nose} 4-${nose} 4H12Z" fill="#f0c58d"/>
  <circle cx="19" cy="14" r="1.3" fill="#233f33"/>
  <g font-family="system-ui, sans-serif" font-size="12">
    <text x="${44 + growth}" y="21" fill="#fff" font-weight="700">Pinocchio</text>
    <text x="${divider + labelWidth / 2}" y="21" fill="#233f33" text-anchor="middle">${escapeHtml(label)}</text>
  </g>
</svg>
`;
  return { svg, width, label };
}

const REPORT_STYLE = `
:root {
  color-scheme: light;
  background: #f5f1e9;
  color: #24332b;
  font: 16px/1.55 system-ui, sans-serif;
}
body { margin: 0; }
main { max-width: 58rem; margin: auto; padding: clamp(1.25rem, 5vw, 4.25rem); }
header { border-bottom: 1px solid #b9beae; padding-bottom: 1.5rem; }
header img { max-width: 100%; height: auto; }
h1, h2 { font-family: Georgia, serif; font-weight: 500; line-height: 1.13; }
h1 { font-size: clamp(2.6rem, 8vw, 5rem); margin: .55rem 0; overflow-wrap: anywhere; }
h2 { font-size: 2rem; margin: 0 0 .75rem; }
section { margin: 2rem 0; }
p { margin: .45rem 0; }
.meta { color: #4f5d54; font-size: .88rem; overflow-wrap: anywhere; }
a { color: #245544; text-underline-offset: .2em; }
a:focus-visible, summary:focus-visible { outline: 2px solid #245544; outline-offset: 3px; }
.metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(6.5rem, 1fr)); gap: .5rem; margin: 1rem 0; }
.metrics div { display: flex; flex-direction: column-reverse; padding: .65rem; background: #e9eade; }
.metrics dd { margin: 0; font: 1.65rem Georgia, serif; }
.metrics dt { font-size: .8rem; }
article { background: #fffdf7; border: 1px solid #d7d7c8; padding: .9rem 1.15rem; margin: .55rem 0; overflow-wrap: anywhere; }
.claim-meta { display: flex; flex-wrap: wrap; align-items: baseline; gap: .45rem .65rem; }
.status { border-radius: .25rem; padding: .08rem .45rem; background: #ece9df; font-size: .8rem; font-weight: 650; }
.passed { background: #dce9dd; color: #244734; }
.failed { background: #f4dfd7; color: #792b26; }
blockquote { margin: .55rem 0; padding-left: .7rem; border-left: 2px solid #acae9a; white-space: pre-wrap; }
details { margin-top: .55rem; font-size: .875rem; }
.round { margin: 1rem 0 .3rem; padding: .55rem 0 0; border-top: 1px solid #d7d7c8; }
.round h3 { font-size: 1rem; margin: 0; }
.override { border-left: 2px solid #9a6231; background: #f8eddd; padding: .45rem .65rem; }
summary { cursor: pointer; color: #245544; font-weight: 600; }
ul { margin: .45rem 0; padding-left: 1.4rem; }
li { margin: .25rem 0; }
li span { display: block; }
`;
