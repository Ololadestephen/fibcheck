/**
 * Live evaluation of extraction against pinned public docs:
 *   PINOCCHIO_LIVE=1 npx vitest run src/claims/claims.live.test.ts
 * Each completed document is recorded in .pinocchio/eval-claims.json.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createModelClient, loadDotEnv } from "../model/config.js";
import { extractClaimsCached } from "./cache.js";
import { normalise } from "./quotes.js";
import type { Claim, ClaimType } from "./types.js";

interface Expected {
  quote: string;
  types: ClaimType[];
}

interface Review extends Expected {
  line: number;
  criteria: string;
  /** Patterns (case-insensitive) that the generated check must all contain. */
  mustMention?: string[];
}

interface EvaluationDocument {
  repo: string;
  commit: string;
  path: string;
  expected: Expected[];
  review?: Review[];
}

const EVAL_PATH = ".pinocchio/eval-claims.json";
const MINIMUM_FOUND = 15;

function matchesQuote(claim: Claim, expected: Expected): boolean {
  return normalise(claim.quote).includes(normalise(expected.quote));
}

function scoreClaims(claims: Claim[], expected: Expected[]) {
  return expected.map((entry) => {
    const candidates = claims.filter((claim) => matchesQuote(claim, entry));
    const match = candidates.find((claim) => entry.types.includes(claim.type));
    return { expected: entry, claim: match ?? candidates[0] ?? null, ok: match !== undefined };
  });
}

function mentionsAll(check: string, patterns: string[]): boolean {
  return patterns.every((pattern) => new RegExp(pattern, "i").test(check));
}

function reviewChecks(claims: Claim[], reviews: Review[]) {
  return reviews.map((review) => {
    const candidates = claims.filter((claim) => (
      claim.source.startLine === review.line && matchesQuote(claim, review)
    ));
    const match = candidates.find((claim) => (
      review.types.includes(claim.type)
      && (claim.type === "untestable" ? claim.reason : claim.check)?.trim()
      && mentionsAll(claim.check ?? "", review.mustMention ?? [])
      && !reviews.some((other) => other !== review && other.line === review.line && matchesQuote(claim, other))
    ));
    return { expected: review, claim: match ?? candidates[0] ?? null, ok: match !== undefined };
  });
}

describe.skipIf(process.env.PINOCCHIO_LIVE !== "1")("claim extraction (live model)", () => {
  it("finds the expected claims and separates the key checks", { timeout: 600_000 }, async () => {
    loadDotEnv();
    const { documents } = JSON.parse(readFileSync("fixtures/expected-claims.json", "utf8")) as { documents: EvaluationDocument[] };
    const client = createModelClient(`eval-claims-${Date.now()}`);
    const total = documents.reduce((sum, document) => sum + document.expected.length, 0);
    const report: Record<string, unknown>[] = [];
    const missingReviews: string[] = [];
    let found = 0;
    let evaluated = 0;

    mkdirSync(".pinocchio", { recursive: true });
    const save = (complete: boolean) => {
      writeFileSync(EVAL_PATH, `${JSON.stringify({ complete, found, evaluated, total, usage: client.usage(), report }, null, 2)}\n`);
    };
    save(false);
    for (const doc of documents) {
      const url = `https://raw.githubusercontent.com/${doc.repo}/${doc.commit}/${doc.path}`;
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`Could not fetch ${doc.repo}/${doc.path} at ${doc.commit} (HTTP ${response.status}).`);
      const content = await response.text();
      const { claims, rejected, cacheHits } = await extractClaimsCached(
        client,
        [{ file: doc.path, content }],
        ".pinocchio/cache/claims",
      );
      const scores = scoreClaims(claims, doc.expected);
      const reviews = reviewChecks(claims, doc.review ?? []);
      found += scores.filter((score) => score.ok).length;
      evaluated += scores.length;
      missingReviews.push(...reviews.filter((review) => !review.ok).map(({ expected }) => (
        `${doc.repo}/${doc.path}:${expected.line} · ${expected.quote}`
      )));
      report.push({ repo: doc.repo, commit: doc.commit, file: doc.path, cacheHits, scores, reviews, rejected, claims });
      save(false);
    }
    save(true);
    console.log(`Claim extraction: ${found} of ${total} expected claims found with an acceptable type. Review the proposed checks in ${EVAL_PATH}.`);
    expect.soft(found).toBeGreaterThanOrEqual(MINIMUM_FOUND);
    expect(missingReviews).toEqual([]);
  });
});

describe("extraction evaluation", () => {
  const limitation = "only allows to create or assign tags";
  const admin = "use the admin app to manage your tags";
  const source = { file: "admin.md", startLine: 55, endLine: 55 };
  const expectations: Review[] = [
    { line: 55, quote: limitation, types: ["behaviour"], criteria: "Check the main UI." },
    { line: 55, quote: admin, types: ["behaviour"], criteria: "Check the admin UI." },
  ];

  it("counts a matching type even if a different type appeared earlier", () => {
    const claims: Claim[] = [
      { id: "1", type: "setup", quote: limitation, source },
      { id: "2", type: "behaviour", quote: limitation, source },
    ];
    expect(scoreClaims(claims, expectations.slice(0, 1))).toMatchObject([{ ok: true, claim: { id: "2" } }]);
  });

  it("requires a separate sourced check for each clause", () => {
    const compound: Claim = { id: "1", type: "behaviour", quote: `While it ${limitation}, you can ${admin}.`, check: "Check the admin UI.", source };
    expect(reviewChecks([compound], expectations).map((review) => review.ok)).toEqual([false, false]);
    const mainClaim = { ...compound, id: "2", quote: limitation, check: "Look for edit and removal actions in the main UI." };
    const adminClaim = { ...compound, id: "3", quote: admin, check: "Check the admin UI." };
    expect(reviewChecks([mainClaim, { ...adminClaim, check: "" }], expectations).map((review) => review.ok)).toEqual([true, false]);
    expect(reviewChecks([mainClaim, adminClaim], expectations).map((review) => review.ok)).toEqual([true, true]);
  });

  it("rejects a check that leaves out what the claim promises", () => {
    const review: Review = { line: 21, quote: "Organize bookmarks with tags", types: ["behaviour"], criteria: "", mustMention: ["filter|search"] };
    const claim: Claim = { id: "1", type: "behaviour", quote: "Organize bookmarks with tags", check: "Create a bookmark with a tag and assert the tag is shown.", source: { file: "README.md", startLine: 21, endLine: 21 } };
    expect(reviewChecks([claim], [review])[0]?.ok).toBe(false);
    expect(reviewChecks([{ ...claim, check: "Filter the list by the tag and assert only the matching bookmark is shown." }], [review])[0]?.ok).toBe(true);
  });
});
