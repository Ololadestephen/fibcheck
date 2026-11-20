import { describe, expect, it } from "vitest";
import { contentHash, freeze, frozenClaims, missingLabelAssertion, namedLabels, parseFrozenFile, type FrozenClaim, type FrozenFile } from "./frozen.js";

const quote = "To open the Admin app, go to the *Settings* view and click on the *Admin* tab.";
const check = "Open the Settings page. Assert exactly: The Settings page content shows a tab labelled 'Admin'. Expected: true. Click the tab labelled 'Admin'.";

function entry(overrides: Partial<FrozenClaim> = {}): FrozenClaim {
  const base = { id: "README.md#L5", type: "ui_flow" as const, quote, startLine: 5, endLine: 5, check, control: "Assert exactly: The Settings page shows a field labelled 'Theme'. Expected: true." };
  const merged = { ...base, ...overrides };
  return { ...merged, contentSha256: overrides.contentSha256 ?? contentHash(merged), reviewed: overrides.reviewed ?? { by: "owner", at: "2026-11-20" } };
}

const file = (claims: FrozenClaim[]): FrozenFile => ({ version: 1, docsFile: "examples/demo/README.md", claims });

describe("frozen claims", () => {
  it("runs a reviewed check exactly as written, with its control", () => {
    const { claims, needsReview } = frozenClaims(file([entry()]));
    expect(needsReview).toEqual([]);
    expect(claims[0]).toMatchObject({ check, control: expect.stringContaining("Theme"), source: { file: "examples/demo/README.md", startLine: 5 } });
  });

  it("holds back an unreviewed check, an edited check and one without an exact-label assertion", () => {
    const edited = { ...entry(), check: `${check} Then also open Tags.` };
    const unlabelled = entry({ check: "Click the Admin tab. Assert exactly: Site administration is shown. Expected: true." });
    const { claims, needsReview } = frozenClaims(file([entry({ reviewed: { by: "", at: "" } }), edited, unlabelled]));
    expect(claims).toEqual([]);
    expect(needsReview.map(({ why }) => why)).toEqual([
      "No one has reviewed this check yet.",
      "The check changed after review. Freeze and review it again.",
      "The check's first assertion must name the tab labelled 'Admin' exactly, before acting on it.",
    ]);
  });

  it("parses only complete files", () => {
    expect(parseFrozenFile(JSON.stringify(file([entry()]))).claims).toHaveLength(1);
    expect(() => parseFrozenFile(JSON.stringify({ version: 2, docsFile: "x", claims: [] }))).toThrow("version 1");
    expect(() => parseFrozenFile(JSON.stringify(file([{ ...entry(), check: "" }])))).toThrow("incomplete");
  });

  it("freezes extracted checks with hashes and no reviewer", () => {
    const frozen = freeze("examples/demo/README.md", [
      { id: "README.md#L5", type: "ui_flow", quote, check, source: { file: "x", startLine: 5, endLine: 5 } },
      { id: "README.md#L3", type: "untestable", quote: "Fast.", reason: "marketing", source: { file: "x", startLine: 3, endLine: 3 } },
    ]);
    expect(frozen.claims).toHaveLength(1);
    expect(frozen.claims[0]).toMatchObject({ contentSha256: contentHash({ quote, check }), reviewed: { by: "", at: "" } });
  });
});

describe("exact-label assertions", () => {
  it("finds the labels a sentence gives UI elements", () => {
    expect(namedLabels(quote)).toEqual([{ label: "Admin", element: "tab" }]);
    expect(namedLabels('Press the "Save" button, then the menu labelled "Export".')).toEqual([
      { label: "Save", element: "button" }, { label: "Export", element: "menu" },
    ]);
    expect(namedLabels("Bookmarks are organised with tags.")).toEqual([]);
  });

  it("requires the first assertion to name each label before it is used", () => {
    expect(missingLabelAssertion({ quote, check })).toBeUndefined();
    expect(missingLabelAssertion({ quote, check: "Click the tab labelled 'Admin'. Assert exactly: The page shows a tab labelled 'Admin'. Expected: true." }))
      .toContain("acts on 'Admin' before asserting");
    expect(missingLabelAssertion({ quote, check: "Assert exactly: The page heading is 'Settings'. Expected: true." })).toContain("labelled 'Admin'");
    expect(missingLabelAssertion({ quote: "Tags can be renamed.", check: "Rename a tag." })).toBeUndefined();
  });
});
