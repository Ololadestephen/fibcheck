import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelClient } from "../model/client.js";
import { EXTRACT_SYSTEM, extractClaims, type ExtractionResult } from "./extract.js";
import type { SourceDocument } from "./types.js";

/**
 * Extracts claims, reusing an earlier result for an identical document and
 * prompt. On the Gemini free tier (20 requests a day per model) this keeps
 * repeated checks of the same README from spending requests.
 */
export async function extractClaimsCached(client: ModelClient, documents: SourceDocument[], cacheDir: string): Promise<ExtractionResult & { cacheHits: number }> {
  const result: ExtractionResult & { cacheHits: number } = { claims: [], rejected: [], cacheHits: 0 };
  mkdirSync(cacheDir, { recursive: true });
  for (const document of documents) {
    const path = join(cacheDir, `${cacheKey(document)}.json`);
    let part = readCache(path);
    if (part) {
      result.cacheHits++;
    } else {
      part = await extractClaims(client, [document]);
      writeFileSync(path, `${JSON.stringify(part, null, 2)}\n`);
    }
    result.claims.push(...part.claims);
    result.rejected.push(...part.rejected);
  }
  return result;
}

/** A damaged cache file counts as a miss, so the document is simply extracted again. */
function readCache(path: string): ExtractionResult | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ExtractionResult;
  } catch {
    return undefined;
  }
}

/** Changes when the document, its path or the extraction prompt changes. */
export function cacheKey(document: SourceDocument): string {
  return createHash("sha256").update(EXTRACT_SYSTEM).update("\0").update(document.file).update("\0").update(document.content).digest("hex").slice(0, 32);
}
