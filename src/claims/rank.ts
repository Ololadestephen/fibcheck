import type { Claim } from "./types.js";

/**
 * How specific a claim is: exact interface names, steps, settings, defaults
 * and shortcuts. Specific claims are the ones that go stale when an interface
 * changes (a renamed menu, a removed switch), and they are the easiest for a
 * browser check to test exactly. Broad marketing lines score low.
 */
export interface RankedClaim {
  claim: Claim;
  score: number;
  reasons: string[];
}

const NAMED = /`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*|"[^"]+"|“[^”]+”|'[A-Z][^']+'/g;
const CONTROLS = /\b(tab|menu|button|link|page|settings?|options?|checkbox|toggle|switch|dropdown|drop-down|sidebar|toolbar|icon|dialog|field|panel|section|shortcut|key)s?\b/gi;
const STEPS = /\b(go to|click|clicking|select|open|navigate|press|tap|choose|enable|disable|deselect|check|uncheck)\b|→|>/gi;
const DEFAULTS = /\bby default\b|\bdefaults? to\b|\b\d+(\.\d+)?\b/gi;

const TYPE_WEIGHT: Record<Claim["type"], number> = { ui_flow: 3, behaviour: 1, setup: -2, mobile: -5, untestable: -10 };

/** Scores one claim. Higher means more specific. */
export function rankClaim(claim: Claim): RankedClaim {
  const text = claim.quote;
  const reasons: string[] = [];
  let score = TYPE_WEIGHT[claim.type];
  const count = (pattern: RegExp) => text.match(pattern)?.length ?? 0;

  const named = Math.min(count(NAMED), 3);
  if (named) reasons.push(`${named} named item${named === 1 ? "" : "s"}`);
  const controls = Math.min(count(CONTROLS), 3);
  if (controls) reasons.push(`${controls} interface word${controls === 1 ? "" : "s"}`);
  const steps = Math.min(count(STEPS), 3);
  if (steps) reasons.push(`${steps} step${steps === 1 ? "" : "s"}`);
  const defaults = Math.min(count(DEFAULTS), 2);
  if (defaults) reasons.push("a default or value");
  score += named * 3 + controls * 2 + steps * 2 + defaults * 2;

  if (text.trim().split(/\s+/).length < 4) {
    score -= 2;
    reasons.push("very short");
  }
  return { claim, score, reasons };
}

/** Orders claims from most to least specific. Ties keep the document order. */
export function rankClaims(claims: Claim[]): RankedClaim[] {
  return claims.map((claim, index) => ({ ranked: rankClaim(claim), index }))
    .sort((a, b) => b.ranked.score - a.ranked.score || a.index - b.index)
    .map(({ ranked }) => ranked);
}
