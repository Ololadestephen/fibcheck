import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiError } from "@google/genai";
import { describe, expect, it } from "vitest";
import { BudgetExceededError, CallBudget } from "./budget.js";
import { ModelClient } from "./client.js";
import { createModelClient, readLimits } from "./config.js";
import { GeminiProvider, type GenerateContentApi } from "./gemini.js";
import { RateLimitedError, type ModelProvider } from "./types.js";

function tempBudget(maxCallsPerRun: number, maxCallsTotal: number, runId = "run-1", dir = mkdtempSync(join(tmpdir(), "pino-"))) {
  return {
    dir,
    budget: new CallBudget({ maxCallsPerRun, maxCallsTotal }, runId, join(dir, "totals.json"), join(dir, "ledger.jsonl")),
  };
}

const echoProvider: ModelProvider = {
  name: "fake",
  async generate(request, beforeAttempt) {
    beforeAttempt();
    return { text: JSON.stringify({ echo: request.purpose }), model: "fake-1", usage: { inputTokens: 10, outputTokens: 5 } };
  },
};

const request = { purpose: "test", system: "s", prompt: "p" };

describe("CallBudget", () => {
  it("refuses the call after the per-run limit", () => {
    const { budget } = tempBudget(2, 100);
    budget.reserve();
    budget.reserve();
    expect(() => budget.reserve()).toThrow(BudgetExceededError);
  });

  it("refuses calls when the totals file is damaged, instead of resetting it", () => {
    const { dir, budget } = tempBudget(5, 5);
    writeFileSync(join(dir, "totals.json"), "{not json");
    expect(() => budget.reserve()).toThrow(/damaged/);
  });

  it("keeps the total limit across runs", () => {
    const first = tempBudget(10, 3, "run-1");
    first.budget.reserve();
    first.budget.reserve();
    const second = tempBudget(10, 3, "run-2", first.dir);
    second.budget.reserve();
    expect(() => second.budget.reserve()).toThrow(/Total model call limit/);
  });
});

describe("ModelClient", () => {
  it("records each call in the ledger without the prompt text", async () => {
    const { dir, budget } = tempBudget(5, 5);
    const client = new ModelClient(echoProvider, budget);
    await client.generate({ ...request, prompt: "SECRET-LOOKING TEXT" });
    const ledger = readFileSync(join(dir, "ledger.jsonl"), "utf8");
    expect(ledger).toContain('"purpose":"test"');
    expect(ledger).not.toContain("SECRET-LOOKING TEXT");
    expect(client.usage()).toEqual({ calls: 1, inputTokens: 10, outputTokens: 5 });
  });

  it("parses and validates JSON replies", async () => {
    const { budget } = tempBudget(5, 5);
    const client = new ModelClient(echoProvider, budget);
    const { value } = await client.generateJson({ ...request, jsonSchema: {} }, (v) => v as { echo: string });
    expect(value.echo).toBe("test");
  });

  it("does not call the provider once the budget is spent", async () => {
    const { budget } = tempBudget(1, 5);
    let calls = 0;
    const counting: ModelProvider = {
      name: "c",
      async generate(_r, beforeAttempt) {
        beforeAttempt();
        calls++;
        return { text: "{}", model: "c", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const client = new ModelClient(counting, budget);
    await client.generate(request);
    await expect(client.generate(request)).rejects.toThrow(BudgetExceededError);
    expect(calls).toBe(1);
  });
});

describe("GeminiProvider", () => {
  it("asks for JSON and counts thinking tokens as output", async () => {
    let seen: Parameters<GenerateContentApi["generateContent"]>[0] | undefined;
    const api: GenerateContentApi = {
      async generateContent(params) {
        seen = params;
        return { text: "{}", usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, thoughtsTokenCount: 2 } };
      },
    };
    const response = await new GeminiProvider({ retryDelaysMs: [0, 0], api, model: "m1" }).generate({ ...request, jsonSchema: { type: "object" } }, () => {});
    expect(seen?.config.responseMimeType).toBe("application/json");
    expect(response).toEqual({ text: "{}", model: "m1", usage: { inputTokens: 7, outputTokens: 5 } });
  });

  it("falls back to the second model on a rate limit", async () => {
    const models: string[] = [];
    const api: GenerateContentApi = {
      async generateContent(params) {
        models.push(params.model);
        if (params.model === "main") throw new ApiError({ message: "quota", status: 429 });
        return { text: "ok" };
      },
    };
    const response = await new GeminiProvider({ retryDelaysMs: [0, 0], api, model: "main", fallbackModel: "lite" }).generate(request, () => {});
    expect(models).toEqual(["main", "lite"]);
    expect(response.model).toBe("lite");
  });

  it("falls back to the second model when the main model times out on the server", async () => {
    const api: GenerateContentApi = {
      async generateContent(params) {
        if (params.model === "main") throw new ApiError({ message: "DEADLINE_EXCEEDED", status: 504 });
        return { text: "ok" };
      },
    };
    expect((await new GeminiProvider({ retryDelaysMs: [0, 0], api, model: "main", fallbackModel: "lite" }).generate(request, () => {})).model).toBe("lite");
  });

  it("makes at most three requests, each announced to the budget, and waits between them", async () => {
    let requests = 0;
    let announced = 0;
    const waits: number[] = [];
    const api: GenerateContentApi = {
      async generateContent() {
        requests++;
        throw new ApiError({ message: "overloaded", status: 503 });
      },
    };
    const provider = new GeminiProvider({ api, model: "a", fallbackModel: "b", retryDelaysMs: [5, 7], sleep: async (ms) => void waits.push(ms) });
    await expect(provider.generate(request, () => void announced++)).rejects.toThrow(/overloaded or timing out/);
    expect([requests, announced, waits]).toEqual([3, 3, [5, 7]]);
  });

  it("stops retrying when the budget refuses the next request", async () => {
    let requests = 0;
    const api: GenerateContentApi = {
      async generateContent() {
        requests++;
        throw new ApiError({ message: "overloaded", status: 503 });
      },
    };
    const { budget } = tempBudget(2, 10);
    const client = new ModelClient(new GeminiProvider({ api, model: "a", fallbackModel: "b", retryDelaysMs: [0, 0] }), budget);
    await expect(client.generate(request)).rejects.toThrow(BudgetExceededError);
    expect(requests).toBe(2);
  });

  it("reports a clear error when both models are rate limited", async () => {
    const api: GenerateContentApi = {
      async generateContent() {
        throw new ApiError({ message: "quota", status: 429 });
      },
    };
    await expect(new GeminiProvider({ retryDelaysMs: [0, 0], api, model: "a", fallbackModel: "b" }).generate(request, () => {})).rejects.toThrow(RateLimitedError);
  });

  it("does not retry other API errors", async () => {
    let calls = 0;
    const api: GenerateContentApi = {
      async generateContent() {
        calls++;
        throw new ApiError({ message: "bad key details", status: 400 });
      },
    };
    await expect(new GeminiProvider({ retryDelaysMs: [0, 0], api }).generate(request, () => {})).rejects.toThrow("Gemini API error (HTTP 400).");
    expect(calls).toBe(1);
  });
});

describe("config", () => {
  it("rejects a limit that is not a positive whole number", () => {
    expect(() => readLimits({ PINOCCHIO_MAX_CALLS_PER_RUN: "0" })).toThrow(/positive whole number/);
    expect(readLimits({})).toEqual({ maxCallsPerRun: 60, maxCallsTotal: 1500 });
  });

  it("explains how to get a key when none is set", () => {
    expect(() => createModelClient("r", tmpdir(), {})).toThrow(/aistudio.google.com\/apikey/);
  });
});
