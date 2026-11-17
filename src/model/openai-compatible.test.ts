import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FallbackProvider, OpenAICompatibleProvider, SpendCapError } from "./openai-compatible.js";
import { ProviderOverloadedError, RateLimitedError, type ModelProvider, type ModelRequest } from "./types.js";

const request: ModelRequest = { purpose: "test", system: "Reply with JSON.", prompt: "Say ok.", jsonSchema: { type: "object" } };
const KEY = "sk-test-key-never-printed";

function provider(fetchImpl: typeof fetch, maxUsd = 0.2, spendPath = join(mkdtempSync(join(tmpdir(), "fibcheck-near-")), "spend.json")) {
  return {
    spendPath,
    near: new OpenAICompatibleProvider({
      label: "near", baseUrl: "https://api.invalid/v1", apiKey: KEY, model: "small-model",
      prices: { inputPerMillion: 0.1, outputPerMillion: 0.4 }, maxUsd, spendPath, maxOutputTokens: 1000, fetch: fetchImpl,
    }),
  };
}

function reply(status: number, body: unknown = {}): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
}

describe("OpenAICompatibleProvider", () => {
  it("sends a JSON-schema chat request, returns the text and records the cost", async () => {
    let sent: { url: string; init: RequestInit } | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      sent = { url, init };
      return new Response(JSON.stringify({ choices: [{ message: { content: "{\"ok\":true}" } }], usage: { prompt_tokens: 1000, completion_tokens: 500 } }), { status: 200 });
    }) as unknown as typeof fetch;
    const { near, spendPath } = provider(fetchImpl);
    let attempts = 0;
    const response = await near.generate(request, () => attempts++);
    expect(attempts).toBe(1);
    expect(response).toEqual({ text: "{\"ok\":true}", model: "near:small-model", usage: { inputTokens: 1000, outputTokens: 500 } });
    expect(sent?.url).toBe("https://api.invalid/v1/chat/completions");
    const body = JSON.parse(String(sent?.init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ model: "small-model", max_tokens: 1000, response_format: { type: "json_schema" } });
    expect(JSON.parse(readFileSync(spendPath, "utf8")).usd).toBeCloseTo(0.0003, 8);
  });

  it("refuses before sending when the worst case would pass the cap", async () => {
    let called = false;
    const { near } = provider((async () => { called = true; return new Response("{}"); }) as typeof fetch, 0.0001);
    let attempts = 0;
    await expect(near.generate(request, () => attempts++)).rejects.toThrow(SpendCapError);
    expect(called).toBe(false);
    expect(attempts).toBe(0);
  });

  it("refuses when the spend file is damaged", async () => {
    const { near, spendPath } = provider(reply(200));
    writeFileSync(spendPath, "not json");
    await expect(near.generate(request, () => {})).rejects.toThrow("damaged");
  });

  it.each([
    [429, RateLimitedError],
    [503, ProviderOverloadedError],
    [500, Error],
  ])("maps HTTP %i without leaking the key", async (status, type) => {
    const { near } = provider(reply(status));
    const error = await near.generate(request, () => {}).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(type);
    expect(String(error)).not.toContain(KEY);
  });
});

describe("FallbackProvider", () => {
  const failing = (error: Error): ModelProvider => ({ name: "primary", async generate(_r, before) { before(); throw error; } });
  const backup: ModelProvider = { name: "backup", async generate(_r, before) { before(); return { text: "{}", model: "backup", usage: { inputTokens: 1, outputTokens: 1 } }; } };

  it.each([new RateLimitedError("quota"), new ProviderOverloadedError("busy")])("uses the backup after %s and counts both requests", async (error) => {
    let attempts = 0;
    const response = await new FallbackProvider(failing(error), backup).generate(request, () => attempts++);
    expect(response.model).toBe("backup");
    expect(attempts).toBe(2);
  });

  it("does not hide other errors behind the backup", async () => {
    await expect(new FallbackProvider(failing(new Error("bad request")), backup).generate(request, () => {})).rejects.toThrow("bad request");
  });
});
