import { CallBudget } from "./budget.js";
import { errorMessage } from "../util.js";
import { UnusableModelOutputError, type ModelProvider, type ModelRequest, type ModelResponse } from "./types.js";

/**
 * The one entry point for model calls. The provider must announce every HTTP
 * request through `beforeAttempt`, which reserves it in the call budget first;
 * each call is then recorded in the usage ledger.
 */
export class ModelClient {
  constructor(
    private readonly provider: ModelProvider,
    private readonly budget: CallBudget,
  ) {}

  async generate(request: ModelRequest): Promise<ModelResponse> {
    let attempts = 0;
    try {
      const response = await this.provider.generate(request, () => {
        this.budget.reserve();
        attempts += 1;
      });
      if (attempts === 0) throw new Error(`Provider ${this.provider.name} answered without announcing its request.`);
      this.budget.record({ purpose: request.purpose, model: response.model, ...response.usage, ok: true });
      return response;
    } catch (error) {
      if (attempts === 0) throw error;
      this.budget.record({ purpose: request.purpose, model: this.provider.name, inputTokens: 0, outputTokens: 0, ok: false });
      throw error;
    }
  }

  /** Asks for JSON matching `jsonSchema`, parses it, and checks it with `validate`. */
  async generateJson<T>(
    request: ModelRequest & { jsonSchema: Record<string, unknown> },
    validate: (value: unknown) => T,
  ): Promise<{ value: T; response: ModelResponse }> {
    const response = await this.generate(request);
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripCodeFence(response.text));
    } catch {
      throw new UnusableModelOutputError(`The model did not return valid JSON for "${request.purpose}".`);
    }
    try {
      return { value: validate(parsed), response };
    } catch (error) {
      throw new UnusableModelOutputError(`The model's reply for "${request.purpose}" had the wrong shape: ${errorMessage(error)}`);
    }
  }

  /** Calls, tokens and answering models for this run, and how spending is limited. */
  usage(): ReturnType<CallBudget["runSummary"]> & { spendingLimit: string } {
    return { ...this.budget.runSummary(), spendingLimit: this.provider.spendingLimit ?? "call cap only (free tier, no dollar cost)" };
  }
}

/** Some OpenAI-compatible models wrap JSON in a Markdown code fence; the fence is removed before parsing. */
function stripCodeFence(text: string): string {
  const match = text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1] ?? text;
}
