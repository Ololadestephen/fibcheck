/** The kinds of claim Pinocchio sorts a README into. */
export const CLAIM_TYPES = ["setup", "ui_flow", "behaviour", "mobile", "untestable"] as const;
export type ClaimType = (typeof CLAIM_TYPES)[number];

/** Where a claim was found. Line numbers are 1-based and inclusive. */
export interface ClaimSource {
  file: string;
  startLine: number;
  endLine: number;
}

export interface Claim {
  /** Stable within one run, for example "README.md#L26". */
  id: string;
  type: ClaimType;
  /** The claim exactly as written in the document. */
  quote: string;
  source: ClaimSource;
  /** For testable claims: what a browser test would do and expect. */
  check?: string;
  /** For untestable claims: why a browser test cannot check it. */
  reason?: string;
}

/** A claim the model proposed but whose quote was not found in the document. */
export interface RejectedClaim {
  quote: string;
  file: string;
  why: string;
}

/** One document to read, with its path as shown in reports. */
export interface SourceDocument {
  file: string;
  content: string;
}
