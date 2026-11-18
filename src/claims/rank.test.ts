import { describe, expect, it } from "vitest";
import { rankClaim, rankClaims } from "./rank.js";
import type { Claim } from "./types.js";

function claim(id: string, quote: string, type: Claim["type"] = "behaviour"): Claim {
  return { id, type, quote, source: { file: "README.md", startLine: 1, endLine: 1 }, check: "Check it." };
}

describe("rankClaims", () => {
  it("puts exact interface steps above broad feature lines", () => {
    const ranked = rankClaims([
      claim("broad", "Clean UI optimized for readability"),
      claim("steps", "Click the Recipe Settings gear and deselect `Disable Ingredient Amounts`", "ui_flow"),
      claim("default", "The `fileupload` option enables or disables the file upload feature, defaults to false."),
    ]).map(({ claim: c }) => c.id);
    expect(ranked).toEqual(["steps", "default", "broad"]);
  });

  it("keeps document order for equal scores", () => {
    expect(rankClaims([claim("a", "Markdown notes support"), claim("b", "Bookmark sharing support")]).map(({ claim: c }) => c.id)).toEqual(["a", "b"]);
  });

  it("explains the score and marks setup and very short claims down", () => {
    const steps = rankClaim(claim("s", "Go to `Settings` → `Reverse Proxy` → `HTTP Headers` and set `Trust Proxy` to Yes.", "ui_flow"));
    expect(steps.reasons).toEqual(expect.arrayContaining(["3 named items", expect.stringMatching(/step/)]));
    expect(rankClaim(claim("short", "add, edit")).reasons).toContain("very short");
    expect(rankClaim(claim("setup", "Run the container on port 8080", "setup")).score)
      .toBeLessThan(rankClaim(claim("ui", "Run the container on port 8080", "ui_flow")).score);
  });
});
