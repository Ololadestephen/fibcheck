/**
 * The provider-neutral interface for Pinocchio's own agent.
 *
 * Everything outside `src/model` talks to a `ModelClient`, never to a
 * provider SDK, so a provider can be swapped (or replaced by an MCP host
 * such as Claude Code or Codex) without touching the rest of the code.
 */

/** One request to a language model. */
export interface ModelRequest {
  /** Short label for the call, recorded in the usage ledger (for example "extract-claims"). */
  purpose: string;
  /** Instructions for the model. */
  system: string;
  /** The task text. Must contain only public data: README text, Kane results, public code. */
  prompt: string;
  /** When set, the model must reply with JSON matching this JSON Schema. */
  jsonSchema?: Record<string, unknown>;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/** What a provider returns for one request. */
export interface ModelResponse {
  text: string;
  /** The model that actually answered (may be a fallback model). */
  model: string;
  usage: TokenUsage;
}

/** A model provider, such as the Gemini API. */
export interface ModelProvider {
  readonly name: string;
  /**
   * Answers one request. A provider that makes more than one HTTP request
   * (for example to retry) must call `beforeAttempt` before each of them,
   * so the call budget counts every real request.
   */
  generate(request: ModelRequest, beforeAttempt: () => void): Promise<ModelResponse>;
}

/** Raised when a provider rejects a request because of rate limits. */
export class RateLimitedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitedError";
  }
}
