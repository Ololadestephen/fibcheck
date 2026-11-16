/**
 * Live evaluation of claim extraction against the lead's expected lists.
 * Calls the real model, so it runs only with PINOCCHIO_LIVE=1 and a key in .env:
 *   PINOCCHIO_LIVE=1 npx vitest run src/claims/claims.live.test.ts
 * Results, including every miss, are written to .pinocchio/eval-claims.json.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extractClaims } from "./extract.js";
import { normalise } from "./quotes.js";
import { createModelClient, loadDotEnv } from "../model/config.js";

interface Expected {
  quote: string;
  types: string[];
}
interface Spec {
  documents: { repo: string; commit: string; path: string; expected: Expected[] }[];
}

const live = process.env.PINOCCHIO_LIVE === "1";

describe.skipIf(!live)("claim extraction (live model)", () => {
  it("finds the claims the lead expects", { timeout: 600_000 }, async () => {
    loadDotEnv();
    const spec = JSON.parse(readFileSync("fixtures/expected-claims.json", "utf8")) as Spec;
    const client = createModelClient(`eval-claims-${Date.now()}`);
    const report: Record<string, unknown>[] = [];
    let found = 0;
    let total = 0;

    for (const doc of spec.documents) {
      const url = `https://raw.githubusercontent.com/${doc.repo}/${doc.commit}/${doc.path}`;
      const content = await (await fetch(url)).text();
      const file = `${doc.repo}/${doc.path}`;
      const { claims, rejected } = await extractClaims(client, [{ file, content }]);
      for (const expected of doc.expected) {
        total++;
        const match = claims.find((c) => normalise(c.quote).includes(normalise(expected.quote)));
        const typeOk = match !== undefined && expected.types.includes(match.type);
        if (typeOk) found++;
        report.push({ file, expected: expected.quote, expectedTypes: expected.types, got: match ? { quote: match.quote, type: match.type, id: match.id } : null, ok: typeOk });
      }
      report.push({ file, extracted: claims.length, rejected });
    }

    mkdirSync(".pinocchio", { recursive: true });
    writeFileSync(".pinocchio/eval-claims.json", `${JSON.stringify({ found, total, usage: client.usage(), report }, null, 2)}\n`);
    console.log(`Claim extraction: ${found} of ${total} expected claims found with an acceptable type. Details in .pinocchio/eval-claims.json`);
    expect(found).toBeGreaterThanOrEqual(total - 3);
  });
});
