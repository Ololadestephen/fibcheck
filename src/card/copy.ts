import { createHash } from "node:crypto";
import type { Finding } from "../findings.js";
import type { ClaimVerdict } from "../loop-types.js";

const stamps: Record<ClaimVerdict, string> = {
  false: "FALSE",
  outdated: "OUTDATED",
  true: "ALL HELD",
  worded_differently: "WORDED DIFFERENTLY",
  unconfirmed: "UNCONFIRMED",
};

const captions: Record<ClaimVerdict, readonly [string, string]> = {
  false: ["The docs said it. The app said no.", "The docs and the app compared notes. Briefly."],
  outdated: ["The app moved on. The docs didn't get the memo.", "The docs are sending postcards from an older version."],
  true: ["Suspiciously honest.", "The docs and the app are on speaking terms."],
  worded_differently: ["Technically true. The best kind of true.", "Same job. Different name tag."],
  unconfirmed: ["We asked. The app shrugged.", "No verdict. The needle would like a minute."],
};

const ownCaptions: Partial<typeof captions> = {
  false: ["Our README fibbed. Awkward.", "Our README made a promise. Our app would like a word."],
  outdated: ["Our README is living in the past.", "Our docs have declined to update their priors."],
};

type AppScore = { held: number; failed: number; unconfirmed: number; worded: number };

// The README and docs/wiki verdict tables in index/README.md, plus the two earlier
// Linkding findings. Soryn comes from its saved seven-claim check and wording finding.
// Do not subtract the old finding totals from claims: that would count unknowns as held.
const appScores: Readonly<Record<string, AppScore>> = {
  "mealie-recipes/mealie@e2c0c3b1bfd7a785dde8e9704f1c8475333613ae": { held: 3, failed: 1, unconfirmed: 1, worded: 0 },
  "louislam/uptime-kuma.wiki@cf7fe32": { held: 3, failed: 1, unconfirmed: 1, worded: 0 },
  "sissbruecker/linkding@27b7303baf41bb28babc610ac8eaa486e1ddfab5": { held: 3, failed: 2, unconfirmed: 1, worded: 0 },
  "Soryn@8876c08": { held: 7, failed: 0, unconfirmed: 0, worded: 1 },
};

export function countVerdicts(finding: Finding, entries: readonly Finding[]) {
  const byClaim = new Map<string, ClaimVerdict>();
  for (const { source, quote, verdict } of entries) {
    if (source.repo !== finding.source.repo || source.commit !== finding.source.commit) continue;
    const key = JSON.stringify([source.file, source.line, quote]);
    const previous = byClaim.get(key);
    byClaim.set(key, previous === undefined || previous === verdict ? verdict : "unconfirmed");
  }
  const verdicts = [...byClaim.values()];
  const worded = verdicts.filter((verdict) => verdict === "worded_differently").length;
  const held = verdicts.filter((verdict) => verdict === "true").length + worded;
  const failed = verdicts.filter((verdict) => verdict === "false" || verdict === "outdated").length;
  const unconfirmed = verdicts.filter((verdict) => verdict === "unconfirmed").length;
  return { held, resolved: held + failed, unconfirmed, worded };
}

export function evidenceLine(finding: Finding): string {
  const { failures, control, held } = finding.evidence;
  const count = new Set(failures).size;
  return [
    count > 1 ? `Failed in ${count} separate runs` : count === 1 ? "Failed in 1 run" : "",
    control && (count ? "control passed" : "Control passed"),
    held && !count && "Behaviour held in Kane's run",
  ].filter(Boolean).join(" · ");
}

function scoreCopy(finding: Finding, entries: readonly Finding[]) {
  const { repo, commit } = finding.source;
  const app = appScores[`${repo}@${commit}`];
  const counts = app ? { ...app, resolved: app.held + app.failed } : countVerdicts(finding, entries);
  const { held, resolved, worded, unconfirmed } = counts;
  const denominator = app ? resolved + unconfirmed : resolved;
  const suffix = app
    ? `${denominator === 1 ? "line" : "lines"} held up`
    : `${denominator === 1 ? "claim" : "claims"} told the truth`;
  return { held, resolved, worded, unconfirmed, denominator, suffix, scope: app ? "App check" : "Recorded findings" };
}

function verdictNote(verdict: ClaimVerdict, worded: number, unconfirmed: number): string {
  return [worded && verdict !== "worded_differently" ? `${worded} worded differently` : "", unconfirmed ? `${unconfirmed} couldn't be checked` : ""].filter(Boolean).join(" · ");
}

export function cardText(finding: Finding, entries: readonly Finding[] = [finding]) {
  const counts = scoreCopy(finding, entries);
  const { held, resolved, worded, unconfirmed, denominator, suffix } = counts;
  const { file, line, commit } = finding.source;
  const pool = (finding.own ? ownCaptions[finding.verdict] : undefined) ?? captions[finding.verdict];
  const pickSecond = createHash("sha256").update(finding.id).digest().readUInt8(0) >= 128;
  const quote = [...finding.quote.replace(/\s+/gu, " ").trim()];
  const segments = file.split("/");
  const path = segments.length > 2 ? `…/${segments.slice(-2).join("/")}` : file;
  return {
    ...counts,
    stamp: finding.verdict === "true" && (held < resolved || unconfirmed > 0) ? "HELD" : stamps[finding.verdict],
    caption: pickSecond ? pool[1] : pool[0],
    quote: quote.length > 90 ? `${quote.slice(0, 89).join("").trimEnd()}…` : quote.join(""),
    source: `${finding.project} · ${path}:${line} · ${commit.slice(0, 7)}`,
    score: denominator ? `${held} of ${denominator} ${suffix}` : "No resolved claims",
    note: verdictNote(finding.verdict, worded, unconfirmed),
    evidence: evidenceLine(finding),
    merged: finding.upstream?.status === "merged" ? "Fix merged by the maintainers ✓" : "",
  };
}
