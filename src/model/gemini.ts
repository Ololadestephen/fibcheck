import { ApiError, GoogleGenAI } from "@google/genai";
import { RateLimitedError, type ModelProvider, type ModelRequest, type ModelResponse } from "./types.js";

/**
 * Default models (approval A2; both stable and on the free tier per aistudio.google.com/docs/pricing, 2026-11-16).
 * gemini-3.8-flash was tried first but timed out on the server (HTTP 504 DEADLINE_EXCEEDED) twice on a tiny prompt.
 */
export const DEFAULT_GEMINI_MODEL = "gemini-3.6-flash";
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
}

/**
 * Calls the Gemini API. On a rate limit or an overloaded or timed-out server
 * (HTTP 429, 503 or 504) it retries once on the fallback model. It never logs the request, the response or the key.
 */
export class GeminiProvider implements ModelProvider {
  readonly name = "gemini";
  private readonly model: string;
  private readonly fallbackModel: string;
  private readonly api: GenerateContentApi;

  constructor(options: GeminiOptions = {}) {
    this.model = options.model ?? DEFAULT_GEMINI_MODEL;
    this.fallbackModel = options.fallbackModel ?? DEFAULT_GEMINI_FALLBACK_MODEL;
    // One attempt and a timeout: the SDK's default of 5 hidden retries with waits up to
    // 60 seconds would hide rate limits and spend free-tier quota our call limits never see.
    this.api =
      options.api ??
      new GoogleGenAI({ httpOptions: { timeout: REQUEST_TIMEOUT_MS, retryOptions: { attempts: 1 } } }).models;
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    try {
      return await this.call(this.model, request);
    } catch (error) {
      if (!isRetryable(error) || this.fallbackModel === this.model) throw toProviderError(error);
    }
    try {
      return await this.call(this.fallbackModel, request);
    } catch (error) {
      throw toProviderError(error);
    }
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

/** Errors worth one try on the fallback model: rate limits, overload and server timeouts. */
function isRetryable(error: unknown): boolean {
  return error instanceof ApiError && [429, 503, 504].includes(error.status);
}

/** Turns SDK errors into short messages that cannot carry the key or the prompt. */
function toProviderError(error: unknown): Error {
  if (isRateLimit(error)) {
    return new RateLimitedError(
      "Gemini rate limit reached on both the main and the fallback model. Wait and try again, or lower the number of claims per run.",
    );
  }
  if (error instanceof ApiError) {
    return new Error(`Gemini API error (HTTP ${error.status}).`);
  }
  return error instanceof Error ? error : new Error("Unknown error from the Gemini provider.");
}
