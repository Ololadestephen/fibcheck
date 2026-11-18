import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractClaims } from "../claims/extract.js";
import { CallBudget } from "./budget.js";
import { ModelClient } from "./client.js";
import { createModelClient, createModelFromEnv } from "./config.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";
import { UnusableModelOutputError, type ModelProvider } from "./types.js";

const dir = () => mkdtempSync(join(tmpdir(), "fibcheck-model-"));

describe("createModelFromEnv", () => {
  it("leaves Gemini as the default when no model address is set", () => {
    expect(createModelFromEnv(dir(), {})).toBeUndefined();
  });

  it("uses OpenAI with a dollar cap when prices are given", () => {
    const provider = createModelFromEnv(dir(), {
      FIBCHECK_MODEL_BASE_URL: "https://api.openai.com/v1", FIBCHECK_MODEL_API_KEY: "sk-test", FIBCHECK_MODEL: "gpt-4.1-mini",
      FIBCHECK_MODEL_PRICE_INPUT: "0.4", FIBCHECK_MODEL_PRICE_OUTPUT: "1.6", FIBCHECK_MODEL_MAX_USD: "0.5",
    });
    expect(provider?.name).toBe("api.openai.com:gpt-4.1-mini");
    expect(provider?.spendingLimit).toContain("dollar cap $0.50");
  });

  it("uses only the call cap, and says so, when prices are unknown (OpenRouter)", () => {
    const provider = createModelFromEnv(dir(), {
      FIBCHECK_MODEL_BASE_URL: "https://openrouter.ai/api/v1", FIBCHECK_MODEL_API_KEY: "sk-or-test", FIBCHECK_MODEL: "meta-llama/llama-3.3-70b-instruct",
    });
    expect(provider?.spendingLimit).toBe("call cap only (this model's prices are unknown, so its dollar cost is not tracked)");
  });

  it("allows a local Ollama server without a key", () => {
    const provider = createModelFromEnv(dir(), { FIBCHECK_MODEL_BASE_URL: "http://localhost:11434/v1", FIBCHECK_MODEL: "qwen3:8b" });
    expect(provider?.name).toBe("localhost:qwen3:8b");
  });

  it.each([
    [{ FIBCHECK_MODEL_BASE_URL: "https://api.openai.com/v1", FIBCHECK_MODEL_API_KEY: "k" }, "FIBCHECK_MODEL must name the model"],
    [{ FIBCHECK_MODEL_BASE_URL: "https://api.openai.com/v1", FIBCHECK_MODEL: "m" }, "FIBCHECK_MODEL_API_KEY is missing for api.openai.com"],
    [{ FIBCHECK_MODEL_BASE_URL: "api.openai.com", FIBCHECK_MODEL: "m", FIBCHECK_MODEL_API_KEY: "k" }, "must be an http or https address"],
    [{ FIBCHECK_MODEL_BASE_URL: "https://x.test/v1", FIBCHECK_MODEL: "m", FIBCHECK_MODEL_API_KEY: "k", FIBCHECK_MODEL_PRICE_INPUT: "1" }, "Set both"],
    [{ FIBCHECK_MODEL_BASE_URL: "https://x.test/v1", FIBCHECK_MODEL: "m", FIBCHECK_MODEL_API_KEY: "k", FIBCHECK_MODEL_PRICE_INPUT: "1", FIBCHECK_MODEL_PRICE_OUTPUT: "x" }, "must be a positive number"],
  ])("rejects an incomplete setup %#", (env, message) => {
    expect(() => createModelFromEnv(dir(), env)).toThrow(message);
  });

  it("builds a client for a chosen model without a Gemini key, and still applies the call cap", () => {
    const client = createModelClient("r", dir(), { FIBCHECK_MODEL_BASE_URL: "http://127.0.0.1:11434/v1", FIBCHECK_MODEL: "llama3.2", FIBCHECK_MAX_CALLS_PER_RUN: "1" });
    expect(client.usage().spendingLimit).toContain("call cap only");
  });

  it("explains both options when no model is configured", () => {
    expect(() => createModelClient("r", dir(), {})).toThrow(/GEMINI_API_KEY.*FIBCHECK_MODEL_BASE_URL/s);
  });
});

describe("a provider without known prices", () => {
  it("sends no key header when none is set, tracks no dollars, and strips a JSON code fence", async () => {
    const home = dir();
    let headers: Record<string, string> = {};
    const provider = new OpenAICompatibleProvider({
      label: "localhost", baseUrl: "http://localhost:11434/v1", model: "m",
      fetch: (async (_url: string, init: RequestInit) => {
        headers = init.headers as Record<string, string>;
        return new Response(JSON.stringify({ choices: [{ message: { content: "```json\n{\"ok\":true}\n```" } }] }));
      }) as unknown as typeof fetch,
    });
    const client = new ModelClient(provider, new CallBudget({ maxCallsPerRun: 2, maxCallsTotal: 2 }, "r", join(home, "t"), join(home, "l")));
    const { value } = await client.generateJson({ purpose: "p", system: "s", prompt: "p", jsonSchema: {} }, (v) => v as { ok: boolean });
    expect(value).toEqual({ ok: true });
    expect(headers.Authorization).toBeUndefined();
    expect(provider.spent()).toBe(0);
    expect(existsSync(join(home, "model-spend.json"))).toBe(false);
  });
});

describe("unusable model output", () => {
  const replying = (text: string): ModelProvider => ({
    name: "stub", async generate(_r, before) { before(); return { text, model: "stub", usage: { inputTokens: 1, outputTokens: 1 } }; },
  });
  const clientFor = (text: string) => {
    const home = dir();
    return new ModelClient(replying(text), new CallBudget({ maxCallsPerRun: 5, maxCallsTotal: 5 }, "r", join(home, "t"), join(home, "l")));
  };

  it.each(["this is not JSON", "{\"items\": []}"])("is reported as unusable, not guessed: %s", async (text) => {
    await expect(clientFor(text).generateJson({ purpose: "p", system: "s", prompt: "p", jsonSchema: {} }, (v) => {
      if (!Array.isArray((v as { claims?: unknown }).claims)) throw new Error("no claims list");
      return v;
    })).rejects.toThrow(UnusableModelOutputError);
  });

  it("leaves a document part without claims instead of stopping the check", async () => {
    const result = await extractClaims(clientFor("Sorry, I cannot help with that."), [{ file: "README.md", content: "# App\n\nClick the Save button.\n" }]);
    expect(result.claims).toEqual([]);
    expect(result.unusable).toEqual([{ file: "README.md", lines: "1-250", why: expect.stringContaining("did not return valid JSON") }]);
  });
});
