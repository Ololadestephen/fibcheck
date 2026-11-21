import { createHash } from "node:crypto";
import { CLAIM_TYPES, type Claim, type ClaimType } from "./claims/types.js";
import type { AssertionMode } from "./kane/runner.js";

/**
 * Frozen checks: a claims file generated once, reviewed by a person and committed. A check run from it is
 * the exact reviewed text; nothing regenerates or rewords it. Each claim carries a hash of its quote, check
 * and control, so a check edited after review is refused instead of being run silently. The hash guards
 * against drift; who may change the file is decided by code review on the trusted branch.
 */
export interface FrozenClaim {
  id: string;
  type: ClaimType;
  /** The documentation sentence, exactly as written. */
  quote: string;
  startLine: number;
  endLine: number;
  /** The reviewed browser check. Kane runs exactly this text. */
  check: string;
  /** A reviewed nearby flow that should pass if the setup is valid. Without one, no failure can become a finding. */
  control?: string;
  /** How Kane evaluates assertions. "visual" judges what is shown on screen, not hidden page markup. */
  assertionMode?: AssertionMode;
  /** sha256 of the quote, check and control, written by `fibcheck freeze`. */
  contentSha256: string;
  /** Who reviewed the check, and when. A claim without a reviewer is not run. */
  reviewed: { by: string; at: string };
}

export interface FrozenFile {
  version: 1;
  /** The repository-relative documentation file these claims come from. */
  docsFile: string;
  claims: FrozenClaim[];
}

export function contentHash(claim: Pick<FrozenClaim, "quote" | "check" | "control">): string {
  return createHash("sha256").update(JSON.stringify([claim.quote, claim.check, claim.control ?? ""])).digest("hex");
}

/** A claim that cannot be run as it stands, and why. Shown as "needs review". */
export interface NeedsReview {
  id: string;
  line: number;
  why: string;
}

export function parseFrozenFile(text: string): FrozenFile {
  let value: Partial<FrozenFile> | null;
  try {
    value = JSON.parse(text) as Partial<FrozenFile> | null;
  } catch {
    throw new Error("The frozen claims file is not valid JSON.");
  }
  if (value?.version !== 1 || typeof value.docsFile !== "string" || !Array.isArray(value.claims)) {
    throw new Error("The frozen claims file must have version 1, a docsFile and a claims list.");
  }
  const incomplete = value.claims.find((claim) => !isComplete(claim));
  if (incomplete !== undefined) throw new Error(`Frozen claim ${String((incomplete as { id?: unknown } | null)?.id)} is incomplete.`);
  return value as FrozenFile;
}

function isComplete(claim: Partial<FrozenClaim> | null): boolean {
  if (!claim) return false;
  const text = [claim.id, claim.quote, claim.check, claim.contentSha256].every((field) => typeof field === "string" && field.length > 0);
  const lines = Number.isSafeInteger(claim.startLine) && Number.isSafeInteger(claim.endLine);
  const optional = (claim.control === undefined || typeof claim.control === "string")
    && (claim.assertionMode === undefined || claim.assertionMode === "dom" || claim.assertionMode === "visual");
  return text && lines && optional && CLAIM_TYPES.includes(claim.type as ClaimType);
}

/**
 * Splits a frozen file into claims that may run and claims that need a person's review: a missing reviewer,
 * a check edited after its hash was written, or a missing exact-label assertion.
 */
export function frozenClaims(file: FrozenFile): { claims: Claim[]; needsReview: NeedsReview[] } {
  const claims: Claim[] = [];
  const needsReview: NeedsReview[] = [];
  for (const frozen of file.claims) {
    const flag = (why: string) => needsReview.push({ id: frozen.id, line: frozen.startLine, why });
    if (!frozen.reviewed?.by?.trim() || !frozen.reviewed?.at?.trim()) flag("No one has reviewed this check yet.");
    else if (contentHash(frozen) !== frozen.contentSha256) flag("The check changed after review. Freeze and review it again.");
    else {
      const claim: Claim = {
        id: frozen.id, type: frozen.type, quote: frozen.quote, check: frozen.check,
        source: { file: file.docsFile, startLine: frozen.startLine, endLine: frozen.endLine },
        ...(frozen.control ? { control: frozen.control } : {}),
        ...(frozen.assertionMode ? { assertionMode: frozen.assertionMode } : {}),
      };
      const missing = missingLabelAssertion(claim);
      if (missing) flag(missing);
      else claims.push(claim);
    }
  }
  return { claims, needsReview };
}

const ELEMENTS = "tabs?|menus?|buttons?|links?|dropdowns?";
/** Labels the documentation gives a UI element: "*Admin* tab", "the Save button", 'a tab labelled "Admin"'. */
export function namedLabels(quote: string): { label: string; element: string }[] {
  const found: { label: string; element: string }[] = [];
  const before = new RegExp(`(?:\\*\\*?|"|“|\`)([^*"”\`]{1,40})(?:\\*\\*?|"|”|\`)\\s+(${ELEMENTS})\\b`, "gi");
  const after = new RegExp(`\\b(${ELEMENTS})\\s+(?:labell?ed|named|called)\\s+(?:\\*\\*?|"|“|\`|')([^*"”\`']{1,40})`, "gi");
  for (const match of quote.matchAll(before)) found.push({ label: match[1]!.trim(), element: match[2]!.toLowerCase() });
  for (const match of quote.matchAll(after)) found.push({ label: match[2]!.trim(), element: match[1]!.toLowerCase() });
  return found;
}

/**
 * Rule for every claim that names a UI element: the check's first assertion is an exact-label assertion for
 * each named element, made before anything is clicked by that label. Returns why the check fails the rule.
 */
export function missingLabelAssertion(claim: Pick<Claim, "quote" | "check">): string | undefined {
  const check = claim.check ?? "";
  const firstAssertion = check.match(/Assert exactly:[^]*?(?:Expected: (?:true|false)\.|$)/i)?.[0] ?? "";
  for (const named of namedLabels(claim.quote)) {
    const problem = labelProblem(check, firstAssertion, named);
    if (problem) return problem;
  }
  return undefined;
}

function labelProblem(check: string, firstAssertion: string, { label, element }: { label: string; element: string }): string | undefined {
  const singular = element.replace(/s$/, "");
  const quoted = new RegExp(`(?:'|"|“)${escape(label)}(?:'|"|”)`, "i");
  if (!quoted.test(firstAssertion) || !new RegExp(`\\b${singular}`, "i").test(firstAssertion)) {
    return `The check's first assertion must name the ${singular} labelled '${label}' exactly, before acting on it.`;
  }
  const firstUse = check.search(new RegExp(`\\b(?:click|select|open|press)\\b[^.]*${escape(label)}`, "i"));
  return firstUse !== -1 && firstUse < check.indexOf(firstAssertion) ? `The check acts on '${label}' before asserting that its ${singular} exists.` : undefined;
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Builds a frozen file from extracted claims, for a person to review. Reviewer fields are left empty. */
export function freeze(docsFile: string, claims: Claim[]): FrozenFile {
  return {
    version: 1,
    docsFile,
    claims: claims.filter((claim) => claim.type !== "untestable" && claim.check).map((claim) => {
      const entry = { quote: claim.quote, check: claim.check!, control: claim.control };
      return {
        id: claim.id, type: claim.type, quote: claim.quote, startLine: claim.source.startLine, endLine: claim.source.endLine,
        check: claim.check!, ...(claim.control ? { control: claim.control } : {}),
        contentSha256: contentHash(entry), reviewed: { by: "", at: "" },
      };
    }),
  };
}
