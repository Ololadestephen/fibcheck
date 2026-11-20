import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { attackSummary, judgeByKane, judgeByRule, parseLazyFixes, runAttack, type AttackInput, type LazyFix } from "./attack.js";
import { CallBudget } from "./model/budget.js";
import { ModelClient } from "./model/client.js";
import type { KaneRun } from "./kane/runner.js";
import type { ModelProvider } from "./model/types.js";

const input: AttackInput = {
  file: "Maintenance.md",
  original: "You can access the maintenance management via the menu at the top left.",
  fix: "You can access the maintenance management via the menu at the top right.",
};

describe("judgeByRule", () => {
  it("rejects deleting the line", () => {
    expect(judgeByRule({ kind: "delete", text: "" }, input)).toMatchObject({ outcome: "rejected_by_rule", reason: expect.stringContaining("hides the problem") });
  });

  it("rejects a hedged line that keeps the wrong detail", () => {
    const result = judgeByRule({ kind: "hedge", text: "You may be able to access maintenance via the menu at the top left." }, input);
    expect(result).toMatchObject({ outcome: "rejected_by_rule", reason: expect.stringContaining('"may"') });
  });

  it("rejects a vaguer line than the proven fix", () => {
    expect(judgeByRule({ kind: "vague", text: "Maintenance is available." }, input)?.outcome).toBe("rejected_by_rule");
  });

  it("rejects a line that keeps the topic but drops the position", () => {
    expect(judgeByRule({ kind: "vague", text: "You can access the maintenance management via the menu." }, input)).toMatchObject({
      outcome: "rejected_by_rule", reason: expect.stringContaining("0 checkable details against 2"),
    });
  });

  it("leaves a specific, confident replacement for Kane to decide", () => {
    expect(judgeByRule({ kind: "wrong", text: "Open Settings, then the Maintenance tab.", check: "c" }, input)).toBeUndefined();
  });

  it("does not count the proven fix itself as a lazy fix", () => {
    expect(judgeByRule({ kind: "wrong", text: input.fix }, input)?.outcome).toBe("not_rejected");
  });
});

describe("judgeByKane", () => {
  const wrong: LazyFix = { kind: "wrong", text: "Open Settings, then the Maintenance tab.", check: "c" };
  const kane = (status: "failed" | "passed" | "error") => ({ status, oneLiner: "One line.", outDir: "d" });
  const contradicted = { cause: "claim_contradicted" as const, exercisedClaim: true, reason: "No Maintenance tab in Settings." };
  it.each([
    ["failed", contradicted, "rejected_by_kane"],
    ["failed", { cause: "agent_misstep" as const, exercisedClaim: false, reason: "Kane had not signed in yet." }, "inconclusive"],
    ["failed", { cause: "claim_contradicted" as const, exercisedClaim: false, reason: "Kane used another page." }, "inconclusive"],
    ["passed", { cause: "unclear" as const, exercisedClaim: true, reason: "Opened it there." }, "not_rejected"],
    ["passed", { cause: "unclear" as const, exercisedClaim: false, reason: "Reached it through the account menu instead." }, "inconclusive"],
    ["error", contradicted, "inconclusive"],
  ] as const)("Kane %s with a reading gives %s (%#)", (status, reading, outcome) => {
    expect(judgeByKane(wrong, kane(status), reading).outcome).toBe(outcome);
  });

  it("never rejects or accepts on Kane's word alone", () => {
    expect(judgeByKane(wrong, kane("failed")).outcome).toBe("inconclusive");
    expect(judgeByKane(wrong, kane("passed")).outcome).toBe("inconclusive");
  });
});

describe("attackSummary", () => {
  it("counts only rejections that happened", () => {
    expect(attackSummary([
      { kind: "delete", text: "", outcome: "rejected_by_rule", reason: "" },
      { kind: "wrong", text: "w", outcome: "rejected_by_kane", reason: "" },
      { kind: "hedge", text: "h", outcome: "inconclusive", reason: "" },
    ])).toBe("2 lazy fixes rejected (1 by Kane).");
    expect(attackSummary([{ kind: "wrong", text: "w", outcome: "not_rejected", reason: "" }])).toBe("");
  });
});

describe("runAttack", () => {
  it("adds a deletion, applies the rules, and asks Kane only about the wrong detail", async () => {
    const reply = { vague: "Maintenance is in a menu.", hedge: "Maintenance may be in the menu at the top left.", wrong: "Open Settings, then the Maintenance tab.", check: "Open Settings and assert a Maintenance tab." };
    const provider: ModelProvider = { name: "stub", async generate(_r, before) { before(); return { text: JSON.stringify(reply), model: "stub", usage: { inputTokens: 1, outputTokens: 1 } }; } };
    const dir = mkdtempSync(join(tmpdir(), "fibcheck-attack-"));
    const client = new ModelClient(provider, new CallBudget({ maxCallsPerRun: 2, maxCallsTotal: 2 }, "r", join(dir, "t"), join(dir, "l")));
    const kaneAsked: string[] = [];
    const results = await runAttack(client, input, async (attempt) => {
      kaneAsked.push(attempt.text);
      return { status: "failed", oneLiner: "Settings has no Maintenance tab.", outDir: "out" } as unknown as KaneRun;
    }, async () => ({
      exercisedClaim: true, cause: "claim_contradicted", reason: "Settings has no Maintenance tab.", ownMistakeRuledOut: "Signed in.",
      kaneBlame: "none", blameEvidence: "", revisedCheck: "", controlCheck: "", visibleWording: "",
    }));
    expect(results.map(({ kind, outcome }) => `${kind}:${outcome}`)).toEqual([
      "delete:rejected_by_rule", "vague:rejected_by_rule", "hedge:rejected_by_rule", "wrong:rejected_by_kane",
    ]);
    expect(kaneAsked).toEqual(["Open Settings, then the Maintenance tab."]);
  });

  it("refuses a reply without a check for the wrong detail", () => {
    expect(() => parseLazyFixes({ vague: "a", hedge: "b", wrong: "c" })).toThrow("no check");
  });
});
