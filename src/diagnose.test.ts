import { describe, expect, it } from "vitest";
import type { Claim } from "./claims/types.js";
import { DIAGNOSE_SYSTEM, diagnosisPrompt, modelDiagnoser, parseDiagnosis } from "./diagnose.js";
import { parseKaneOutput } from "./kane/parse.js";
import type { KaneRun } from "./kane/runner.js";
import { CallBudget } from "./model/budget.js";
import { ModelClient } from "./model/client.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const claim: Claim = {
  id: "README.md#L9", type: "behaviour", quote: "preview and edit your files",
  source: { file: "README.md", startLine: 9, endLine: 9 }, check: "Open the file.",
};

function failedRun(): KaneRun {
  const result = parseKaneOutput([
    JSON.stringify({ type: "step", step: 1, status: "done", remark: "type: Type Pk0123456789abcdef into Password at http://localhost:19095/login" }),
    JSON.stringify({
      type: "run_end", status: "failed", reason_code: "assertion_error.checkpoint_failed", one_liner: "Saved under /Users/someone/.testmuai/x",
      test_url: "https://example.test/session/123", session_dir: "/Users/someone/.testmuai/sessions/1",
      verdict: { family: "application_issue", category: "functional_defect", root_cause: "Editor did not save Pk0123456789abcdef", confidence: 0.9 },
    }),
  ].join("\n"), 1);
  return { ...result, objective: "", startUrl: "http://localhost:19095/", outDir: "/Users/someone/runs/x", evidence: [], evidenceError: null };
}

const reading = {
  exercisedClaim: true, cause: "agent_misstep", reason: "Kane clicked the wrong file.", ownMistakeRuledOut: "",
  kaneBlame: "disagree", blameEvidence: "Step 1 shows the wrong file.", revisedCheck: "Open pino.txt.", controlCheck: "",
};

describe("diagnosisPrompt", () => {
  it("sends the claim and Kane's result without secrets, URLs, paths or session links", () => {
    const prompt = diagnosisPrompt(claim, claim.check ?? "", failedRun(), ["Pk0123456789abcdef"]);
    expect(prompt).toContain("preview and edit your files");
    expect(prompt).toContain("assertion_error.checkpoint_failed");
    expect(prompt).toContain("[secret]");
    for (const leak of ["Pk0123456789abcdef", "localhost", "example.test", "/Users/", "session/123"]) expect(prompt).not.toContain(leak);
  });

  it("removes the address of the app under test even when it is public", () => {
    const run = failedRun();
    run.reason = "Opened https://bookmarks.example.org/settings and bookmarks.example.org/tags";
    const prompt = diagnosisPrompt(claim, "", run, ["bookmarks.example.org"]);
    expect(prompt).not.toContain("bookmarks.example.org");
  });

  it("keeps public addresses so a reworded check can still use them", () => {
    const run = failedRun();
    run.reason = "Typed https://example.com into the URL field at http://localhost:19091/new";
    const prompt = diagnosisPrompt(claim, "Add a bookmark for https://example.com.", run);
    expect(prompt).toContain("https://example.com");
    expect(prompt).not.toContain("localhost");
  });

  it("removes hosts without a scheme and other local paths", () => {
    const run = failedRun();
    run.reason = "Opened localhost:8080/admin, then 127.0.0.1:3000 and [::1]:5230, read ~/notes.txt, /opt/app/x, /root/y and C:\\Users\\me\\z";
    const prompt = diagnosisPrompt(claim, "", run);
    for (const leak of ["localhost", "127.0.0.1", "::1", "~/notes", "/opt/app", "/root/y", "Users\\\\me"]) expect(prompt).not.toContain(leak);
  });
});

describe("DIAGNOSE_SYSTEM", () => {
  it("treats a control the sentence itself names, absent where it says, as a contradiction", () => {
    expect(DIAGNOSE_SYSTEM).toContain("If the documentation sentence itself names a control, menu, page or position");
    expect(DIAGNOSE_SYSTEM).toContain("a search somewhere else is agent_misstep");
  });

  it("does not count a dropdown item as a tab inside a page", () => {
    expect(DIAGNOSE_SYSTEM).toContain("An item in a dropdown or navigation menu is not a tab inside a page");
  });
});

describe("parseDiagnosis", () => {
  it("accepts a complete reading", () => {
    expect(parseDiagnosis(reading)).toMatchObject({ cause: "agent_misstep", kaneBlame: "disagree", revisedCheck: "Open pino.txt." });
  });

  it.each([
    [{ ...reading, cause: "lie" }, "unknown cause"],
    [{ ...reading, kaneBlame: "maybe" }, "unknown blame"],
    [{ ...reading, exercisedClaim: "yes" }, "exercised"],
    [{ ...reading, reason: 4 }, "not text"],
    [null, "not an object"],
  ])("rejects %j", (value, message) => {
    expect(() => parseDiagnosis(value)).toThrow(message);
  });
});

describe("modelDiagnoser", () => {
  it("asks the shared client for JSON and counts the call", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fibcheck-diagnose-"));
    const prompts: string[] = [];
    const client = new ModelClient({
      name: "fake",
      async generate(request, before) {
        before();
        prompts.push(request.prompt);
        expect(request.purpose).toBe("diagnose-run");
        expect(request.jsonSchema).toBeDefined();
        return { text: JSON.stringify(reading), model: "fake", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    }, new CallBudget({ maxCallsPerRun: 2, maxCallsTotal: 2 }, "t", join(dir, "totals.json"), join(dir, "ledger.jsonl")));
    const result = await modelDiagnoser(client, ["Pk0123456789abcdef"])(claim, "Open the file.", failedRun());
    expect(result.cause).toBe("agent_misstep");
    expect(prompts[0]).not.toContain("Pk0123456789abcdef");
    expect(client.usage().calls).toBe(1);
  });
});
