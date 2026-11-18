import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ProviderOverloadedError, RateLimitedError, type ModelProvider, type ModelRequest, type ModelResponse } from "./types.js";

/** Prices in US dollars per million tokens. */
export interface TokenPrices {
  inputPerMillion: number;
  outputPerMillion: number;
}

export interface OpenAICompatibleOptions {
  /** Short provider label, recorded with the model name (for example "near"). */
  label: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  prices: TokenPrices;
  /** Hard spending cap in US dollars across all runs, kept in `spendPath`. */
  maxUsd: number;
  spendPath: string;
  /** Upper bound on output tokens per request, so the worst-case cost of a request is known before it is sent. */
  maxOutputTokens?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** Raised when a request could take spending past the dollar cap. */
export class SpendCapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpendCapError";
  }
}

/**
 * A provider for OpenAI-compatible chat completion APIs, such as NEAR AI Cloud.
 * Before each request it checks that the worst case (the prompt plus the
 * output-token limit) still fits under the dollar cap, and afterwards it
 * records the actual cost from the response's token usage.
 */
export class OpenAICompatibleProvider implements ModelProvider {
  readonly name: string;
  private readonly maxOutputTokens: number;

  constructor(private readonly options: OpenAICompatibleOptions) {
    this.name = `${options.label}:${options.model}`;
    this.maxOutputTokens = options.maxOutputTokens ?? 16_000;
  }

  async generate(request: ModelRequest, beforeAttempt: () => void = () => {}): Promise<ModelResponse> {
    const spent = this.spent();
    const worstCase = this.cost(estimateTokens(request.system + request.prompt), this.maxOutputTokens);
    if (spent + worstCase > this.options.maxUsd) {
      throw new SpendCapError(`The ${this.options.label} spending cap of $${this.options.maxUsd.toFixed(2)} would be exceeded ($${spent.toFixed(4)} spent).`);
    }
    beforeAttempt();
    let data: { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    try {
      data = await this.send(request);
    } catch (error) {
      // The request may have been billed even though it failed, so count the worst case.
      this.record(worstCase);
      throw error;
    }
    const inputTokens = data.usage?.prompt_tokens ?? 0;
    const outputTokens = data.usage?.completion_tokens ?? 0;
    this.record(data.usage ? this.cost(inputTokens, outputTokens) : worstCase);
    return { text: data.choices?.[0]?.message?.content ?? "", model: this.name, usage: { inputTokens, outputTokens } };
  }

  private async send(request: ModelRequest) {
    const response = await (this.options.fetch ?? fetch)(`${this.options.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.options.apiKey}` },
      body: JSON.stringify(this.body(request)),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 90_000),
    });
    if (!response.ok) throw providerError(this.options.label, response.status);
    return (await response.json()) as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
  }

  /** Dollars spent so far across runs. A damaged file refuses further calls rather than resetting the count. */
  spent(): number {
    if (!existsSync(this.options.spendPath)) return 0;
    let value: unknown;
    try {
      value = (JSON.parse(readFileSync(this.options.spendPath, "utf8")) as { usd?: unknown }).usd;
    } catch {
      value = undefined;
    }
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
    throw new SpendCapError(`The spend file ${this.options.spendPath} is damaged. Fix or delete it on purpose before more paid calls.`);
  }

  private body(request: ModelRequest): Record<string, unknown> {
    return {
      model: this.options.model,
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.prompt },
      ],
      max_tokens: this.maxOutputTokens,
      ...(request.jsonSchema
        ? { response_format: { type: "json_schema", json_schema: { name: "response", schema: request.jsonSchema } } }
        : {}),
    };
  }

  private cost(inputTokens: number, outputTokens: number): number {
    return (inputTokens * this.options.prices.inputPerMillion + outputTokens * this.options.prices.outputPerMillion) / 1_000_000;
  }

  private record(usd: number): void {
    const total = this.spent() + usd;
    mkdirSync(dirname(this.options.spendPath), { recursive: true });
    writeFileSync(this.options.spendPath, `${JSON.stringify({ usd: total }, null, 2)}\n`);
  }
}

/** A cautious token estimate (about 3 characters per token), used only for the worst-case cost check. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

function providerError(label: string, status: number): Error {
  if (status === 429) return new RateLimitedError(`${label} returned HTTP 429. Wait for its rate limit to reset.`);
  if (status === 502 || status === 503 || status === 504) return new ProviderOverloadedError(`${label} is overloaded or timing out (HTTP ${status}).`);
  return new Error(`${label} API error (HTTP ${status}).`);
}

/**
 * Uses the primary provider, and the backup only when the primary refuses for
 * rate limits or overload. Each provider announces its own requests, so the
 * call budget counts both.
 */
export class FallbackProvider implements ModelProvider {
  readonly name: string;

  constructor(
    private readonly primary: ModelProvider,
    private readonly backup: ModelProvider,
  ) {
    this.name = `${primary.name}, then ${backup.name}`;
  }

  async generate(request: ModelRequest, beforeAttempt: () => void): Promise<ModelResponse> {
    try {
      return await this.primary.generate(request, beforeAttempt);
    } catch (error) {
      if (!(error instanceof RateLimitedError || error instanceof ProviderOverloadedError)) throw error;
      return await this.backup.generate(request, beforeAttempt);
    }
  }
}
