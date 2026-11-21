import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { readFindingsFile, type Finding } from "./findings.js";
import type { ClaimVerdict } from "./loop-types.js";

export interface CardText {
  stamp: string;
  headline: string;
  punchline?: string;
  quote: string;
  source: string;
  /** One line per piece of evidence that exists, for the card's list of receipts. */
  receipts: string[];
  evidence: string;
  score: string;
  thanks?: string;
}

const OWN_STAMPS: Record<ClaimVerdict, string> = {
  false: "FIB DETECTED",
  outdated: "OUTDATED",
  true: "VERIFIED",
  worded_differently: "CLOSE ENOUGH?",
  unconfirmed: "CAN'T TELL",
};

/** Third-party projects get no "fib" or "lie": a false line is a mix-up between the docs and the app. */
const THIRD_PARTY_STAMPS: Record<ClaimVerdict, string> = {
  ...OWN_STAMPS,
  false: "MIX-UP",
};

/** The words on a card, built only from the recorded verdict and evidence. */
export function cardText(finding: Finding): CardText {
  const stamp = (finding.own ? OWN_STAMPS : THIRD_PARTY_STAMPS)[finding.verdict];
  const { file, line } = finding.source;
  return {
    stamp,
    headline: headline(finding),
    ...(finding.punchline ? { punchline: finding.punchline } : {}),
    quote: finding.quote,
    source: `${finding.project} · ${file}, line ${line} · ${finding.source.commit.slice(0, 7)}`,
    receipts: receipts(finding),
    evidence: evidenceLine(finding),
    score: scoreLine(finding),
    ...(finding.own ? {} : {
      thanks: finding.upstream?.status === "merged"
        ? `Thanks, ${finding.project} maintainers, for merging the fix. The docs and the app are friends again.`
        : `Thanks, ${finding.project} maintainers. Great project, one small docs update.`,
    }),
  };
}

function headline(finding: Finding): string {
  const isFinding = finding.verdict === "false" || finding.verdict === "outdated";
  const visible = finding.visibleWording ?? "something else";
  if (finding.verdict === "unconfirmed") return "Can't tell. We refuse to guess.";
  if (finding.own) {
    if (finding.verdict === "false") return "Your README fibbed. We have receipts.";
    if (isFinding) return "Your README is living in the past.";
    if (finding.verdict === "worded_differently") return `Your README calls it one thing. The app calls it ${visible}.`;
    return "Your README told the truth. Suspicious, but verified.";
  }
  if (finding.verdict === "outdated") return "The app moved on. This docs line didn't get the memo.";
  if (finding.verdict === "false") return "The docs and the app tell different stories.";
  if (finding.verdict === "worded_differently") return `The app calls it ${visible}. The docs call it something else.`;
  return "The docs said it. The app did it. Love to see it.";
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

/** The same evidence as `evidenceLine`, one plain-spoken line each, for the card's receipts. */
export function receipts(finding: Finding): string[] {
  const { failures, control, fixProof, held } = finding.evidence;
  const lines: string[] = [];
  if (failures.length >= 2) lines.push(`Kane failed it in ${failures.length} separate runs`);
  else if (failures.length === 1) lines.push("Kane failed it once");
  if (held) lines.push("Kane watched it work");
  if (control) lines.push("Control run passed, so the test wasn't broken");
  if (fixProof) lines.push("The corrected wording passed Kane");
  const lazy = finding.lazyFixes;
  if (lazy && lazy.rejected > 0) lines.push(`${lazy.rejected} lazy ${lazy.rejected === 1 ? "fix" : "fixes"} tried and rejected`);
  if (finding.upstream?.status === "merged") lines.push("The maintainers merged the fix");
  return lines;
}

function scoreLine(finding: Finding): string {
  const { findings, claims } = finding.score;
  const claimWord = claims === 1 ? "claim" : "claims";
  if (finding.own) return `${findings} ${findings === 1 ? "fib" : "fibs"} in ${claims} ${claimWord}`;
  return `${findings} out-of-step ${findings === 1 ? "line" : "lines"} in ${claims} ${claimWord} checked`;
}

/** Reads and checks the findings file; every referenced screenshot must exist. */
export function loadFindings(path: string): Finding[] {
  const findings = readFindingsFile(path);
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
 * The card as HTML, 1200 by 675 pixels: a "docs polygraph" printout. The screenshot sits in its own frame and is
 * only scaled to fit (`object-fit: contain`): never cropped, and nothing is drawn over it.
 */
export function renderCardHtml(finding: Finding, imageDataUrl: string): string {
  const text = cardText(finding);
  const tone = finding.verdict === "true" || finding.verdict === "worded_differently" ? "#2f7d4f" : finding.verdict === "unconfirmed" ? "#6b6475" : "#c2412d";
  const calm = finding.verdict === "true" || finding.verdict === "worded_differently";
  const needle = calm
    ? "M0 30 C 60 26, 120 34, 180 30 S 300 26, 360 30 S 480 34, 540 30"
    : finding.verdict === "unconfirmed"
      ? "M0 30 C 60 30, 120 30, 180 30 L 200 22 L 215 38 L 230 30 C 300 30, 420 30, 540 30"
      : "M0 30 C 40 28, 70 32, 100 30 L 130 6 L 150 54 L 170 2 L 190 58 L 210 10 L 230 48 L 250 30 C 300 32, 340 28, 380 30 L 400 14 L 415 46 L 430 30 C 470 29, 510 31, 540 30";
  const reading = calm ? "needle: calm" : finding.verdict === "unconfirmed" ? "needle: shrugged" : "needle: went wild";
  return `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0}
body{width:1200px;height:675px;overflow:hidden;font-family:-apple-system,system-ui,"Segoe UI",sans-serif;color:#1f2a24;
background:#fbf7ec;background-image:linear-gradient(#efe6cf 1px,transparent 1px),linear-gradient(90deg,#efe6cf 1px,transparent 1px);background-size:24px 24px}
.top{height:64px;display:flex;align-items:center;gap:18px;padding:0 32px;border-bottom:3px solid #1f2a24;background:#fbf7ec}
.brand{font-weight:900;font-size:24px;letter-spacing:-.5px}.brand span{color:${tone}}
.sub{font:600 13px ui-monospace,Menlo,monospace;letter-spacing:2px;color:#6d6455;text-transform:uppercase}
.reading{margin-left:auto;color:${tone}}
.main{display:flex;height:calc(675px - 64px - 52px)}
.left{width:540px;padding:24px 28px 16px 32px;display:flex;flex-direction:column;gap:12px}
.stamp{align-self:flex-start;border:5px double ${tone};color:${tone};font-weight:900;font-size:30px;letter-spacing:1px;padding:4px 14px;border-radius:6px;transform:rotate(-4deg);background:#fffdf6}
.headline{font-size:30px;font-weight:850;line-height:1.12;letter-spacing:-.5px}
.punch{font-size:18px;line-height:1.35;color:#3c4a42}
.label{font:700 12px ui-monospace,Menlo,monospace;letter-spacing:2px;color:#6d6455;text-transform:uppercase;margin-top:4px}
.quote{font-size:17px;line-height:1.35;font-style:italic;background:#fffdf6;border:2px dashed #d7c9a6;border-radius:8px;padding:8px 12px}
.source{font-size:12px;color:#6d6455}
.right{flex:1;padding:22px 32px 16px 8px;display:flex;flex-direction:column;gap:10px}
.shot{flex:1;min-height:0;background:#1f2a24;border-radius:10px;padding:10px;display:flex;align-items:center;justify-content:center}
.shot img{max-width:100%;max-height:100%;object-fit:contain;display:block}
.receipts{display:flex;flex-wrap:wrap;gap:6px}
.receipt{font-size:13px;font-weight:600;background:#fffdf6;border:1.5px solid #1f2a24;border-radius:999px;padding:4px 10px}
.receipt:before{content:"✓ ";color:${tone};font-weight:900}
.foot{height:52px;display:flex;align-items:center;justify-content:space-between;gap:24px;padding:0 32px;border-top:3px solid #1f2a24;background:#1f2a24;color:#fbf7ec;font-size:14px}
.foot b{font-size:15px}
</style></head><body>
<div class="top"><div class="brand">fib<span>check</span></div><div class="sub">docs polygraph · printout</div>
<div class="sub reading">${reading}</div><svg class="needle" width="480" height="60" viewBox="0 0 540 60" preserveAspectRatio="none" aria-hidden="true"><path d="${needle}" fill="none" stroke="${tone}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/></svg></div>
<div class="main"><div class="left">
<div class="stamp">${escapeHtml(text.stamp)}</div>
<div class="headline">${escapeHtml(text.headline)}</div>
${text.punchline ? `<div class="punch">${escapeHtml(text.punchline)}</div>` : ""}
<div class="label">The docs said</div>
<div class="quote">“${escapeHtml(text.quote)}”</div>
<div class="source">${escapeHtml(text.source)}</div>
</div><div class="right">
<div class="label">What Kane saw</div>
<div class="shot"><img alt="Kane CLI screenshot, scaled only" src="${imageDataUrl}"></div>
<div class="receipts">${text.receipts.map((line) => `<span class="receipt">${escapeHtml(line)}</span>`).join("")}</div>
</div></div>
<div class="foot"><b>${escapeHtml(text.score)}</b><span>${escapeHtml(text.thanks ?? "Checked in a real browser by Kane CLI.")}</span></div>
</body></html>`;
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

/** Cards are laid out at 1200 by 675 and drawn at twice that, 2400 by 1350 pixels, so they stay sharp on phone and retina screens. */
export const CARD_SCALE = 2;

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
    execFileSync(chrome, ["--headless=new", "--disable-gpu", "--hide-scrollbars", `--force-device-scale-factor=${CARD_SCALE}`,
      "--window-size=1200,675", `--screenshot=${out}`, `file://${page}`], { stdio: "ignore", timeout: 60_000 });
    if (!existsSync(out)) throw new Error("Chrome did not write the card.");
    return out;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
