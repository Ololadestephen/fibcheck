import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import type { ClaimVerdict } from "./loop-types.js";

/**
 * One recorded finding, as kept in `index/findings.json`. Every line on a card
 * comes from these fields, so a card can never claim more than the evidence.
 */
export interface Finding {
  id: string;
  project: string;
  /** Our own project (playful tone) or a third-party project (polite tone, never "fib" or "lie"). */
  own: boolean;
  verdict: ClaimVerdict;
  quote: string;
  source: { repo: string; commit: string; file: string; line: number };
  /** The Kane screenshot shown on the card, relative to the findings file. */
  screenshot: string;
  evidence: {
    /** Screenshots of separate Kane runs that failed the documented claim. */
    failures: string[];
    /** A passing control run, if one was made. */
    control?: string;
    /** A fresh passing Kane run after the documentation fix, if one was made. */
    fixProof?: string;
    /** For a passing run: the screenshot where the behaviour held. */
    held?: string;
  };
  /** For "worded_differently": what the interface actually shows. */
  visibleWording?: string;
  /** The proven fix: the sentence a fresh Kane run passed. Lazy fixes are judged against it. */
  fix?: string;
  /** Lazy-fix attempts that were rejected (T10), as recorded in index/attacks/<id>.json. */
  lazyFixes?: { rejected: number; byKane: number };
  /** What happened to the fix in the project itself, for example a docs PR the maintainers merged. */
  upstream?: { status: "merged"; pr: string; mergedAt: string; mergeCommit: string };
  /** Counts for the project, not percentages: findings among claims tested. */
  score: { findings: number; claims: number };
}

export interface CardText {
  stamp: string;
  headline: string;
  quote: string;
  source: string;
  evidence: string;
  score: string;
  thanks?: string;
}

const OWN_STAMPS: Record<ClaimVerdict, string> = {
  false: "FIB",
  outdated: "OUTDATED",
  true: "TRUE",
  worded_differently: "WORDED DIFFERENTLY",
  unconfirmed: "CAN'T TELL",
};

/** Third-party projects get no "fib" or "lie": a false line is described as not matching the app. */
const THIRD_PARTY_STAMPS: Record<ClaimVerdict, string> = {
  ...OWN_STAMPS,
  false: "DOESN'T MATCH THE APP",
};

/** The words on a card, built only from the recorded verdict and evidence. */
export function cardText(finding: Finding): CardText {
  const stamp = (finding.own ? OWN_STAMPS : THIRD_PARTY_STAMPS)[finding.verdict];
  const { file, line } = finding.source;
  return {
    stamp,
    headline: headline(finding),
    quote: finding.quote,
    source: `${finding.project} · ${file}, line ${line} · ${finding.source.commit.slice(0, 7)}`,
    evidence: evidenceLine(finding),
    score: scoreLine(finding),
    ...(finding.own ? {} : {
      thanks: finding.upstream?.status === "merged"
        ? `Thank you to the ${finding.project} maintainers for a great project, and for merging the docs fix.`
        : `Thank you to the ${finding.project} maintainers for a great project. A small docs update would help.`,
    }),
  };
}

function headline(finding: Finding): string {
  const isFinding = finding.verdict === "false" || finding.verdict === "outdated";
  if (finding.verdict === "unconfirmed") return "Can't tell. We refuse to guess.";
  if (finding.own) {
    if (isFinding) return "Your README fibbed. Here's the receipt.";
    if (finding.verdict === "worded_differently") return `Your README said it differently. The app says ${finding.visibleWording ?? "something else"}.`;
    return "Your README told the truth. Here's the receipt.";
  }
  if (isFinding) return finding.verdict === "outdated" ? "This docs line is outdated." : "This docs line doesn't match the app.";
  if (finding.verdict === "worded_differently") return `The app words this differently: ${finding.visibleWording ?? "see the screenshot"}.`;
  return "This docs line holds.";
}

/** Only the parts that really happened: two failures, a passing control, a proven fix, or a held behaviour. */
export function evidenceLine(finding: Finding): string {
  const { failures, control, fixProof, held } = finding.evidence;
  const parts: string[] = [];
  if (failures.length >= 2) parts.push("Caught twice by Kane.");
  else if (failures.length === 1) parts.push("Caught once by Kane.");
  if (held) parts.push("Behaviour held in Kane's run.");
  if (control) parts.push("Control passed.");
  if (fixProof) parts.push("Fix proven ✓");
  if (finding.upstream?.status === "merged") parts.push("Fix merged by the maintainers ✓");
  const lazy = finding.lazyFixes;
  if (lazy && lazy.rejected > 0) parts.push(`${lazy.rejected} lazy ${lazy.rejected === 1 ? "fix" : "fixes"} rejected${lazy.byKane ? ` (${lazy.byKane} by Kane)` : ""}.`);
  return parts.join(" ");
}

function scoreLine(finding: Finding): string {
  const { findings, claims } = finding.score;
  const claimWord = claims === 1 ? "claim" : "claims";
  if (finding.own) return `${findings} ${findings === 1 ? "fib" : "fibs"} in ${claims} ${claimWord}`;
  return `${findings} outdated or mismatched ${findings === 1 ? "line" : "lines"} in ${claims} ${claimWord} checked`;
}

/** Reads and checks the findings file; every referenced screenshot must exist. */
export function loadFindings(path: string): Finding[] {
  const findings = JSON.parse(readFileSync(path, "utf8")) as Finding[];
  for (const finding of findings) {
    for (const file of evidenceFiles(finding)) {
      if (!existsSync(join(dirname(path), file))) throw new Error(`Finding ${finding.id} refers to a missing file: ${file}`);
    }
    if ((finding.verdict === "false" || finding.verdict === "outdated") && (finding.evidence.failures.length < 2 || !finding.evidence.control)) {
      throw new Error(`Finding ${finding.id} is ${finding.verdict} without two recorded failures and a control.`);
    }
  }
  return findings;
}

export function evidenceFiles(finding: Finding): string[] {
  const { failures, control, fixProof, held } = finding.evidence;
  return [finding.screenshot, ...failures, control, fixProof, held].filter((file): file is string => Boolean(file));
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

/**
 * The card as HTML, 1200 by 675 pixels. The screenshot sits in its own frame and is only scaled to fit
 * (`object-fit: contain`): never cropped, and nothing is drawn over it.
 */
export function renderCardHtml(finding: Finding, imageDataUrl: string): string {
  const text = cardText(finding);
  const tone = finding.verdict === "true" || finding.verdict === "worded_differently" ? "#2f7d4f" : finding.verdict === "unconfirmed" ? "#6b6475" : "#b4462f";
  return `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0}body{width:1200px;height:675px;font-family:-apple-system,system-ui,"Segoe UI",sans-serif;background:#fbf8f1;color:#233f33;display:flex}
.text{width:520px;padding:40px 36px;display:flex;flex-direction:column;gap:18px}
.brand{font-weight:800;font-size:20px;letter-spacing:.5px}.stamp{align-self:flex-start;border:4px solid ${tone};color:${tone};font-weight:900;font-size:30px;padding:6px 14px;border-radius:8px;transform:rotate(-3deg)}
.headline{font-size:24px;font-weight:700;line-height:1.25}.quote{font-size:19px;line-height:1.35;border-left:4px solid #d9cfb8;padding-left:12px;font-style:italic}
.source{font-size:14px;color:#655c75}.evidence{font-size:17px;font-weight:600}.score{font-size:16px}.thanks{font-size:14px;color:#655c75}
.shot{flex:1;padding:24px;display:flex;align-items:center;justify-content:center;background:#233f33}
.shot img{max-width:100%;max-height:100%;object-fit:contain;display:block}
</style></head><body><div class="text">
<div class="brand">fibcheck</div><div class="stamp">${escapeHtml(text.stamp)}</div>
<div class="headline">${escapeHtml(text.headline)}</div>
<div class="quote">“${escapeHtml(text.quote)}”</div><div class="source">${escapeHtml(text.source)}</div>
<div class="evidence">${escapeHtml(text.evidence)}</div><div class="score">${escapeHtml(text.score)}</div>
${text.thanks ? `<div class="thanks">${escapeHtml(text.thanks)}</div>` : ""}
</div><div class="shot"><img alt="Kane CLI screenshot, scaled only" src="${imageDataUrl}"></div></body></html>`;
}

/** Finds a Chrome or Chromium to draw the card; Kane CLI already needs one. */
export function findChrome(env: NodeJS.ProcessEnv = process.env): string {
  const candidates = [
    env.FIBCHECK_CHROME,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter((path): path is string => Boolean(path));
  const found = candidates.find((path) => existsSync(path));
  if (!found) throw new Error("Could not find Chrome or Chromium to draw the card. Set FIBCHECK_CHROME to its path.");
  return found;
}

/** Writes `<outDir>/<id>.png` for one finding and returns its path. */
export function writeCard(findingsPath: string, id: string, outDir: string, chrome = findChrome()): string {
  const finding = loadFindings(findingsPath).find((entry) => entry.id === id);
  if (!finding) throw new Error(`No finding called ${id} in ${findingsPath}.`);
  const image = resolve(dirname(findingsPath), finding.screenshot);
  const mime = extname(image).toLowerCase() === ".png" ? "image/png" : "image/jpeg";
  const html = renderCardHtml(finding, `data:${mime};base64,${readFileSync(image).toString("base64")}`);
  const work = mkdtempSync(join(tmpdir(), "fibcheck-card-"));
  try {
    const page = join(work, "card.html");
    writeFileSync(page, html);
    mkdirSync(outDir, { recursive: true });
    const out = resolve(outDir, `${id}.png`);
    execFileSync(chrome, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1",
      "--window-size=1200,675", `--screenshot=${out}`, `file://${page}`], { stdio: "ignore", timeout: 60_000 });
    if (!existsSync(out)) throw new Error("Chrome did not write the card.");
    return out;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
