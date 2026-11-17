import { ApiError, GoogleGenAI } from "@google/genai";
import { RateLimitedError, type ModelProvider, type ModelRequest, type ModelResponse } from "./types.js";

/**
 * Default models (approval A2). The owner switched the main model to gemini-4-hydrogen on 2026-11-17,
 * on the free tier, after gemini-3.6-flash reached its daily free-tier quota.
 * gemini-3.8-flash was tried earlier but timed out on the server (HTTP 504 DEADLINE_EXCEEDED) twice on a tiny prompt.
 */
export const DEFAULT_GEMINI_MODEL = "gemini-4-hydrogen";
export const DEFAULT_GEMINI_FALLBACK_MODEL = "gemini-3.5-flash-lite";

/** Per-request timeout. Claim extraction on a 250-line part normally answers well within this. */
export const REQUEST_TIMEOUT_MS = 90_000;

/** The part of the Google GenAI client this provider uses, so tests can pass a fake. */
export interface GenerateContentApi {
  generateContent(params: {
    model: string;
    contents: string;
    config: {
      systemInstruction: string;
      responseMimeType?: string;
      responseJsonSchema?: unknown;
    };
  }): Promise<{
    text?: string;
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      thoughtsTokenCount?: number;
    };
  }>;
}

export interface GeminiOptions {
  model?: string;
  fallbackModel?: string;
  /** Injected for tests. Defaults to the real SDK, which reads GEMINI_API_KEY itself. */
  api?: GenerateContentApi;
  /** First retry delay. Each subsequent delay doubles. Tests can pass zero. */
  initialRetryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Retries an overloaded or timed-out Gemini request with exponential backoff.
 * After two capacity failures on the main model, the third attempt uses the
 * lighter model. When that works, subsequent requests on this client use it
 * for the rest of the run. Each HTTP request reserves its own budget slot.
 */
export class GeminiProvider implements ModelProvider {
  readonly name = "gemini";
  private readonly fallbackModel: string;
  private readonly api: GenerateContentApi;
  private readonly initialRetryDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private activeModel: string;

  constructor(options: GeminiOptions = {}) {
    this.fallbackModel = options.fallbackModel ?? DEFAULT_GEMINI_FALLBACK_MODEL;
    this.activeModel = options.model ?? DEFAULT_GEMINI_MODEL;
    this.initialRetryDelayMs = options.initialRetryDelayMs ?? 2_000;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    // One attempt and a timeout: the SDK's default of 5 hidden retries with waits up to
    // 60 seconds would hide rate limits and spend free-tier quota our call limits never see.
    this.api =
      options.api ??
      new GoogleGenAI({ httpOptions: { timeout: REQUEST_TIMEOUT_MS, retryOptions: { attempts: 1 } } }).models;
  }

  async generate(request: ModelRequest, beforeAttempt: () => void = () => {}): Promise<ModelResponse> {
    const firstModel = this.activeModel;
    const plan = [firstModel, firstModel, this.fallbackModel];
    let lastError: unknown;
    for (const [index, model] of plan.entries()) {
      if (index > 0) await this.sleep(this.initialRetryDelayMs * 2 ** (index - 1));
      beforeAttempt();
      try {
        const response = await this.call(model, request);
        if (model === this.fallbackModel) this.activeModel = model;
        return response;
      } catch (error) {
        lastError = error;
        if (!isCapacityError(error)) break;
      }
    }
    throw toProviderError(lastError);
  }

  private async call(model: string, request: ModelRequest): Promise<ModelResponse> {
    const response = await this.api.generateContent({
      model,
      contents: request.prompt,
      config: {
        systemInstruction: request.system,
        ...(request.jsonSchema
          ? { responseMimeType: "application/json", responseJsonSchema: request.jsonSchema }
          : {}),
      },
    });
    const usage = response.usageMetadata ?? {};
    return {
      text: response.text ?? "",
      model,
      usage: {
        inputTokens: usage.promptTokenCount ?? 0,
        outputTokens: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
      },
    };
  }
}

function isRateLimit(error: unknown): boolean {
  return error instanceof ApiError && error.status === 429;
}

function isCapacityError(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 503 || error.status === 504);
}

/** Turns SDK errors into short messages that cannot carry the key or the prompt. */
function toProviderError(error: unknown): Error {
  if (isRateLimit(error)) {
    return new RateLimitedError(
      "Gemini returned HTTP 429. Wait for the active rate limit or project quota to reset.",
    );
  }
  if (error instanceof ApiError && (error.status === 503 || error.status === 504)) {
    return new Error(`Gemini is overloaded or timing out (HTTP ${error.status}). Try again in a few minutes.`);
  }
  if (error instanceof ApiError) {
    return new Error(`Gemini API error (HTTP ${error.status}).`);
  }
  return error instanceof Error ? error : new Error("Unknown error from the Gemini provider.");
}
