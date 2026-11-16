import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectDocuments } from "./documents.js";
import { CHUNK_LINES, chunkDocument, extractClaims, parseRawClaims } from "./extract.js";
import { locateQuote, normalise } from "./quotes.js";
import { CallBudget } from "../model/budget.js";
import { ModelClient } from "../model/client.js";
import type { ModelProvider } from "../model/types.js";

const ADMIN_DOC = [
  "---",
  'title: "Admin"',
  "---",
  "",
  "## Linkding administration page",
  "",
  "To open the Admin app, go the *Settings* view and click on the *Admin* tab. This should open a new window with the admin app.",
  "",
  "While linkding UI currently only allows to create or assign tags, you can use the admin app",
  "to manage your tags.",
].join("\n");

function clientReturning(...replies: unknown[]): ModelClient {
  let i = 0;
  const provider: ModelProvider = {
    name: "fake",
    async generate(_request, beforeAttempt) {
      beforeAttempt();
      return { text: JSON.stringify(replies[i++] ?? { claims: [] }), model: "fake", usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  const dir = mkdtempSync(join(tmpdir(), "pino-"));
  return new ModelClient(provider, new CallBudget({ maxCallsPerRun: 50, maxCallsTotal: 50 }, "t", join(dir, "t.json"), join(dir, "l.jsonl")));
}

describe("quotes", () => {
  it("ignores Markdown emphasis when matching", () => {
    expect(normalise("click on the *Admin* tab")).toBe("click on the admin tab");
  });

  it("finds a quote that the model cited on slightly wrong lines", () => {
    const source = locateQuote(ADMIN_DOC, "click on the Admin tab", { file: "admin.md", startLine: 9, endLine: 9 });
    expect(source).toEqual({ file: "admin.md", startLine: 7, endLine: 7 });
  });

  it("finds a quote that spans two lines", () => {
    const source = locateQuote(ADMIN_DOC, "use the admin app to manage your tags", { file: "admin.md", startLine: 9, endLine: 10 });
    expect(source).toEqual({ file: "admin.md", startLine: 9, endLine: 10 });
  });

  it("rejects a quote that is not in the document", () => {
    expect(locateQuote(ADMIN_DOC, "Admin opens from the user menu", { file: "admin.md", startLine: 7, endLine: 7 })).toBeUndefined();
  });

  it("rejects quotes too short to be meaningful", () => {
    expect(locateQuote(ADMIN_DOC, "Admin", { file: "admin.md", startLine: 7, endLine: 7 })).toBeUndefined();
  });
});

describe("extractClaims", () => {
  it("keeps real quotes, corrects their lines and rejects invented ones", async () => {
    const client = clientReturning({
      claims: [
        { type: "ui_flow", quote: "go the Settings view and click on the Admin tab", startLine: 6, endLine: 6, check: "Open Settings; expect an Admin tab." },
        { type: "behaviour", quote: "linkding UI currently only allows to create or assign tags", startLine: 9, endLine: 9, check: "Look for tag delete." },
        { type: "behaviour", quote: "Tags can be renamed from the sidebar", startLine: 9, endLine: 9 },
        { type: "ui_flow", quote: "go the Settings view and click on the Admin tab", startLine: 7, endLine: 7 },
      ],
    });
    const result = await extractClaims(client, [{ file: "docs/admin.md", content: ADMIN_DOC }]);
    expect(result.claims.map((c) => [c.id, c.type])).toEqual([
      ["docs/admin.md#L7", "ui_flow"],
      ["docs/admin.md#L9", "behaviour"],
    ]);
    expect(result.claims[0]?.check).toContain("Admin tab");
    expect(result.rejected).toEqual([{ quote: "Tags can be renamed from the sidebar", file: "docs/admin.md", why: "quote not found in the document" }]);
  });

  it("keeps the reason for untestable claims", async () => {
    const client = clientReturning({
      claims: [{ type: "untestable", quote: "This should open a new window with the admin app", startLine: 7, endLine: 7, reason: "Kane cannot see windows." }],
    });
    const { claims } = await extractClaims(client, [{ file: "a.md", content: ADMIN_DOC }]);
    expect(claims[0]).toMatchObject({ type: "untestable", reason: "Kane cannot see windows." });
    expect(claims[0]?.check).toBeUndefined();
  });

  it("drops malformed items from the model", () => {
    expect(parseRawClaims({ claims: [{ type: "made_up", quote: "x", startLine: 1, endLine: 1 }, { type: "setup", quote: "x" }] })).toEqual([]);
    expect(() => parseRawClaims({})).toThrow(/no claims list/);
  });

  it("splits long documents and keeps absolute line numbers", () => {
    const content = Array.from({ length: CHUNK_LINES + 5 }, (_, i) => `line ${i + 1}`).join("\n");
    const chunks = chunkDocument({ file: "big.md", content });
    expect(chunks).toHaveLength(2);
    expect(chunks[1]?.split("\n")[0]).toBe(` ${CHUNK_LINES + 1}| line ${CHUNK_LINES + 1}`);
  });
});

describe("collectDocuments", () => {
  it("reads the README, linked Markdown inside the repo and extra docs", () => {
    const repo = mkdtempSync(join(tmpdir(), "pino-repo-"));
    mkdirSync(join(repo, "docs", "guide"), { recursive: true });
    writeFileSync(join(repo, "README.md"), "See [usage](docs/usage.md), [site](https://x.dev/a.md) and [outside](../evil.md).");
    writeFileSync(join(repo, "docs", "usage.md"), "usage");
    writeFileSync(join(repo, "docs", "guide", "admin.md"), "admin");
    const files = collectDocuments(repo, ["docs/guide"]).map((d) => d.file);
    expect(files).toEqual(["README.md", "docs/usage.md", "docs/guide/admin.md"]);
  });

  it("fails clearly when there is no README", () => {
    expect(() => collectDocuments(mkdtempSync(join(tmpdir(), "pino-empty-")))).toThrow(/No README/);
  });
});
