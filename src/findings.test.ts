import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readFindingsFile, writeFindingsFile, type Finding } from "./findings.js";

describe("findings file", () => {
  const dirs: string[] = [];
  const makePath = () => {
    const dir = mkdtempSync(join(tmpdir(), "fibcheck-findings-"));
    dirs.push(dir);
    return join(dir, "findings.json");
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("names the file when the JSON is malformed", () => {
    const path = makePath();
    writeFileSync(path, "{nope");
    expect(() => readFindingsFile(path)).toThrow(`Could not read the findings file ${path}`);
  });

  it("refuses JSON that is not a list", () => {
    const path = makePath();
    writeFileSync(path, "{}");
    expect(() => readFindingsFile(path)).toThrow("expected a list of findings");
  });

  it("reads back what it wrote", () => {
    const path = makePath();
    const findings: Finding[] = [{
      id: "f", project: "P", own: true, verdict: "false", quote: "q", source: { repo: "r", commit: "c", file: "d.md", line: 1 },
      screenshot: "a.jpg", evidence: { failures: ["a.jpg", "b.jpg"], control: "c.jpg" }, score: { findings: 1, claims: 2 },
    }];
    writeFindingsFile(path, findings);
    expect(readFindingsFile(path)).toEqual(findings);
  });
});
