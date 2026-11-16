import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findEvidencePack } from "./evidence.js";

describe("findEvidencePack", () => {
  it("prefers the pack Kane reported, then the newest pack in the session folder", () => {
    const session = mkdtempSync(join(tmpdir(), "pino-s-"));
    mkdirSync(join(session, "evidence"));
    writeFileSync(join(session, "evidence", "a.evidence"), "");
    writeFileSync(join(session, "evidence", "b.evidence"), "");
    expect(findEvidencePack(join(session, "evidence", "a.evidence"), session)).toBe(join(session, "evidence", "a.evidence"));
    expect(findEvidencePack("/missing.evidence", session)).toBe(join(session, "evidence", "b.evidence"));
    expect(findEvidencePack(null, null)).toBeNull();
    expect(findEvidencePack(null, mkdtempSync(join(tmpdir(), "pino-empty-")))).toBeNull();
  });
});
