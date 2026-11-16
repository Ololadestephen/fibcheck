import type { ClaimSource } from "./types.js";

/** Prefixes every line with its 1-based number, so the model can cite lines. */
export function numberLines(content: string): string {
  return splitLines(content)
    .map((line, index) => `${String(index + 1).padStart(4, " ")}| ${line}`)
    .join("\n");
}

export function splitLines(content: string): string[] {
  return content.replace(/\r\n?/g, "\n").split("\n");
}

/**
 * Normalises text for quote matching: drops Markdown emphasis, link
 * targets and code marks, unifies quotes and dashes, collapses whitespace
 * and lower-cases. The model often quotes "Admin tab" for "*Admin* tab".
 */
export function normalise(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/[*_`]/g, "")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Finds where `quote` appears in the document. Tries the cited lines first
 * (with two lines of slack either side), then the whole document. Returns
 * the corrected source, or undefined if the quote is not in the document.
 */
export function locateQuote(content: string, quote: string, cited: ClaimSource): ClaimSource | undefined {
  const lines = splitLines(content);
  const wanted = normalise(quote);
  if (wanted.length < 8) return undefined;

  // Finds the smallest span (at most 12 lines) inside [from, to] that contains the quote:
  // the earliest end line, then the latest start line for that end.
  const searchWindow = (from: number, to: number): ClaimSource | undefined => {
    const first = Math.max(1, from);
    const last = Math.min(lines.length, to);
    for (let end = first; end <= last; end++) {
      for (let start = end; start >= Math.max(first, end - 11); start--) {
        if (normalise(lines.slice(start - 1, end).join(" ")).includes(wanted)) {
          return { file: cited.file, startLine: start, endLine: end };
        }
      }
    }
    return undefined;
  };

  return searchWindow(cited.startLine - 2, cited.endLine + 2) ?? searchWindow(1, lines.length);
}
