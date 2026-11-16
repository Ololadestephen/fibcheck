import { CallBudget } from "./budget.js";
import type { ModelProvider, ModelRequest, ModelResponse } from "./types.js";

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
      parsed = JSON.parse(response.text);
    } catch {
      throw new Error(`The model did not return valid JSON for "${request.purpose}".`);
    }
    return { value: validate(parsed), response };
  }

  usage(): ReturnType<CallBudget["runSummary"]> {
    return this.budget.runSummary();
  }
}
