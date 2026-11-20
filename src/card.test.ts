import { describe, expect, it } from "vitest";
import { cardText, evidenceLine, loadFindings, renderCardHtml, type Finding } from "./card.js";

const base: Finding = {
  id: "x", project: "Example", own: true, verdict: "false", quote: "Click the Admin tab.",
  source: { repo: "me/app", commit: "abcdef1234", file: "docs/admin.md", line: 14 },
  screenshot: "evidence/run1.jpg",
  evidence: { failures: ["evidence/run1.jpg", "evidence/run2.jpg"], control: "evidence/control.jpg", fixProof: "evidence/after.jpg" },
  score: { findings: 3, claims: 40 },
};

describe("cardText", () => {
  it("uses the playful tone and a count-based score for our own projects", () => {
    expect(cardText(base)).toMatchObject({
      stamp: "FIB",
      headline: "Your README fibbed. Here's the receipt.",
      source: "Example · docs/admin.md, line 14 · abcdef1",
      evidence: "Caught twice by Kane. Control passed. Fix proven ✓",
      score: "3 fibs in 40 claims",
    });
    expect(cardText(base).thanks).toBeUndefined();
  });

  it("is polite to third-party projects: no fib or lie, and a thank-you", () => {
    for (const verdict of ["false", "outdated"] as const) {
      const text = cardText({ ...base, own: false, verdict });
      const all = Object.values(text).join(" ").toLowerCase();
      expect(all).not.toMatch(/\bfib|\blie\b|\blied\b/);
      expect(text.thanks).toContain("Thank you to the Example maintainers");
      expect(text.score).toBe("3 outdated or mismatched lines in 40 claims checked");
    }
    expect(cardText({ ...base, own: false, verdict: "outdated" }).stamp).toBe("OUTDATED");
    expect(cardText({ ...base, own: false, verdict: "false" }).stamp).toBe("DOESN'T MATCH THE APP");
  });

  it("maps every verdict to its stamp", () => {
    const stamps = (["true", "worded_differently", "unconfirmed", "outdated"] as const).map((verdict) => cardText({ ...base, verdict }).stamp);
    expect(stamps).toEqual(["TRUE", "WORDED DIFFERENTLY", "CAN'T TELL", "OUTDATED"]);
    expect(cardText({ ...base, verdict: "unconfirmed" }).headline).toBe("Can't tell. We refuse to guess.");
  });

  it("says only the evidence that exists", () => {
    expect(evidenceLine({ ...base, evidence: { failures: ["a"] } })).toBe("Caught once by Kane.");
    expect(evidenceLine({ ...base, evidence: { failures: ["a", "b"], control: "c" } })).toBe("Caught twice by Kane. Control passed.");
    expect(evidenceLine({ ...base, evidence: { failures: [], held: "h", fixProof: "f" } })).toBe("Behaviour held in Kane's run. Fix proven ✓");
    expect(evidenceLine({ ...base, lazyFixes: { rejected: 4, byKane: 1 } })).toBe("Caught twice by Kane. Control passed. Fix proven ✓ 4 lazy fixes rejected (1 by Kane).");
    expect(evidenceLine({ ...base, lazyFixes: { rejected: 0, byKane: 0 } })).toBe("Caught twice by Kane. Control passed. Fix proven ✓");
  });

  it("names the visible wording for a worded-differently card", () => {
    const text = cardText({ ...base, verdict: "worded_differently", visibleWording: '"Attack"', evidence: { failures: [], held: "h" }, score: { findings: 0, claims: 7 } });
    expect(text.headline).toBe('Your README said it differently. The app says "Attack".');
    expect(text.score).toBe("0 fibs in 7 claims");
  });
});

describe("renderCardHtml", () => {
  it("shows the screenshot only scaled, with nothing drawn over it", () => {
    const html = renderCardHtml(base, "data:image/jpeg;base64,AAAA");
    expect(html).toContain("object-fit:contain");
    expect(html).toContain('<div class="shot"><img alt="Kane CLI screenshot, scaled only" src="data:image/jpeg;base64,AAAA"></div>');
    expect(html).toContain("“Click the Admin tab.”");
  });
});

describe("the recorded findings", () => {
  const findings = loadFindings("index/findings.json");

  it("all exist, and every false or outdated one has two failures and a control", () => {
    expect(findings.map(({ id }) => id)).toEqual([
      "mealie-faq-disable-ingredient-amounts", "uptime-kuma-wiki-maintenance-menu", "linkding-admin-tab", "linkding-tags-only-create-or-assign", "soryn-readme-basic-attack",
    ]);
  });

  it("make cards whose text matches each recorded verdict and its evidence", () => {
    const byId = Object.fromEntries(findings.map((finding) => [finding.id, cardText(finding)]));
    expect(byId["mealie-faq-disable-ingredient-amounts"]).toMatchObject({ stamp: "OUTDATED", evidence: "Caught twice by Kane. Control passed. Fix proven ✓" });
    expect(byId["uptime-kuma-wiki-maintenance-menu"]).toMatchObject({ stamp: "DOESN'T MATCH THE APP", evidence: "Caught twice by Kane. Control passed." });
    expect(byId["linkding-admin-tab"]?.evidence).toBe("Caught twice by Kane. Control passed. Fix proven ✓");
    expect(byId["soryn-readme-basic-attack"]).toMatchObject({ stamp: "WORDED DIFFERENTLY", evidence: "Behaviour held in Kane's run. Fix proven ✓", score: "0 fibs in 7 claims" });
  });
});
