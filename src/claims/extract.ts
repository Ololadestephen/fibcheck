import type { ModelClient } from "../model/client.js";
import { locateQuote, normalise, splitLines } from "./quotes.js";
import { CLAIM_TYPES, type Claim, type ClaimType, type RejectedClaim, type SourceDocument } from "./types.js";

/** Documents longer than this are sent in parts, so no claim is lost to a long input. */
export const CHUNK_LINES = 250;

export const EXTRACT_SYSTEM = `You read the README and usage documentation of an open-source web app and list every claim that a browser test could check against the running app.

Claim types:
- setup: how to install or start the app and reach it (commands, URLs, ports, default logins).
- ui_flow: a path through the user interface ("go to Settings and click Import", a named page, menu, tab or button).
- behaviour: what the app does or offers when used (features, keyboard shortcuts, formats it imports or exports, what is shown or hidden, defaults).
- mobile: claims about phones, tablets or mobile apps.
- untestable: a concrete statement a browser test cannot check (performance, security, licence, hosting, third-party services, marketing adjectives such as "fast" or "clean"). Give the reason.

Rules:
- Quote each claim exactly as written, copied character for character from a single place in the document, without the line-number prefix. Keep each quote to one sentence or one list item.
- Give the first and last line number of the quote, using the numbers shown before each line.
- For testable claims, write "check": one or two sentences saying what a browser test should do and what it should see if the claim is true.
- Skip headings, links-only lines, code that is not about using the app, contributor and development instructions, and changelog entries.
- Do not invent claims or merge separate claims. If there are no claims, return an empty list.`;

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    claims: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: [...CLAIM_TYPES] },
          quote: { type: "string" },
          startLine: { type: "integer" },
          endLine: { type: "integer" },
          check: { type: "string" },
          reason: { type: "string" },
        },
        required: ["type", "quote", "startLine", "endLine"],
      },
    },
  },
  required: ["claims"],
} as const;

interface RawClaim {
  type: ClaimType;
  quote: string;
  startLine: number;
  endLine: number;
  check?: string;
  reason?: string;
}

export interface ExtractionResult {
  claims: Claim[];
  rejected: RejectedClaim[];
}

/** Lists the claims in each document, keeping only claims whose quote is really in the document. */
export async function extractClaims(client: ModelClient, documents: SourceDocument[]): Promise<ExtractionResult> {
  const claims: Claim[] = [];
  const rejected: RejectedClaim[] = [];
  const seen = new Set<string>();

  for (const document of documents) {
    for (const chunk of chunkDocument(document)) {
      const { value } = await client.generateJson(
        {
          purpose: "extract-claims",
          system: EXTRACT_SYSTEM,
          prompt: `File: ${document.file}\n\n${chunk}`,
          jsonSchema: RESPONSE_SCHEMA as unknown as Record<string, unknown>,
        },
        parseRawClaims,
      );
      for (const raw of value) {
        const source = locateQuote(document.content, raw.quote, {
          file: document.file,
          startLine: raw.startLine,
          endLine: raw.endLine,
        });
        if (!source) {
          rejected.push({ quote: raw.quote, file: document.file, why: "quote not found in the document" });
          continue;
        }
        const key = `${source.file}:${source.startLine}:${normalise(raw.quote)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        claims.push(toClaim(raw, source, claims));
      }
    }
  }
  claims.sort((a, b) => a.source.file.localeCompare(b.source.file) || a.source.startLine - b.source.startLine);
  return { claims, rejected };
}

/** Splits a document into numbered parts of at most CHUNK_LINES lines, keeping absolute line numbers. */
export function chunkDocument(document: SourceDocument): string[] {
  const lines = splitLines(document.content);
  const chunks: string[] = [];
  for (let start = 0; start < lines.length; start += CHUNK_LINES) {
    chunks.push(
      lines
        .slice(start, start + CHUNK_LINES)
        .map((line, i) => `${String(start + i + 1).padStart(4, " ")}| ${line}`)
        .join("\n"),
    );
  }
  return chunks;
}

/** Checks the model's JSON shape; drops malformed items rather than trusting them. */
export function parseRawClaims(value: unknown): RawClaim[] {
  const list = (value as { claims?: unknown })?.claims;
  if (!Array.isArray(list)) throw new Error("The model reply has no claims list.");
  return list.filter(isRawClaim);
}

function isRawClaim(item: unknown): item is RawClaim {
  if (typeof item !== "object" || item === null) return false;
  const c = item as Record<string, unknown>;
  return (
    typeof c.type === "string" &&
    (CLAIM_TYPES as readonly string[]).includes(c.type) &&
    typeof c.quote === "string" &&
    Number.isInteger(c.startLine) &&
    Number.isInteger(c.endLine) &&
    (c.check === undefined || typeof c.check === "string") &&
    (c.reason === undefined || typeof c.reason === "string")
  );
}

function toClaim(raw: RawClaim, source: Claim["source"], existing: Claim[]): Claim {
  const base = `${source.file}#L${source.startLine}`;
  const clashes = existing.filter((c) => c.id === base || c.id.startsWith(`${base}-`)).length;
  const claim: Claim = { id: clashes === 0 ? base : `${base}-${clashes + 1}`, type: raw.type, quote: raw.quote.trim(), source };
  if (raw.type === "untestable") {
    if (raw.reason) claim.reason = raw.reason;
  } else if (raw.check) {
    claim.check = raw.check;
  }
  return claim;
}
