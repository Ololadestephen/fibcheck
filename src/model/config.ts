import { existsSync } from "node:fs";
import { join } from "node:path";
import { CallBudget, type BudgetLimits } from "./budget.js";
import { ModelClient } from "./client.js";
import { GeminiProvider } from "./gemini.js";
import { FallbackProvider, OpenAICompatibleProvider } from "./openai-compatible.js";
import type { ModelProvider } from "./types.js";

export const DEFAULT_LIMITS: BudgetLimits = { maxCallsPerRun: 60, maxCallsTotal: 1500 };

/**
 * The paid backup on NEAR AI Cloud (owner's decision, 2026-11-17), used only when Gemini's free tier refuses
 * or is overloaded. Prices are from NEAR AI's /v1/model/list on 2026-11-17, in dollars per million tokens.
 */
export const NEAR_BACKUP = {
  baseUrl: "https://cloud-api.near.ai/v1",
  model: "google/gemini-2.5-flash-lite",
  prices: { inputPerMillion: 0.1, outputPerMillion: 0.4 },
  maxUsd: 0.2,
};

/** The NEAR AI backup provider, when NEAR_AI_API_KEY is set. Spending is kept in `<cwd>/.fibcheck/near-spend.json`. */
export function createNearProvider(cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): OpenAICompatibleProvider | undefined {
  if (!env.NEAR_AI_API_KEY) return undefined;
  return new OpenAICompatibleProvider({
    label: "near",
    baseUrl: NEAR_BACKUP.baseUrl,
    apiKey: env.NEAR_AI_API_KEY,
    model: NEAR_BACKUP.model,
    prices: NEAR_BACKUP.prices,
    maxUsd: NEAR_BACKUP.maxUsd,
    spendPath: join(cwd, ".fibcheck", "near-spend.json"),
  });
}

/** Loads `.env` from the working directory if present. Values are never printed. */
export function loadDotEnv(cwd = process.cwd()): void {
  const path = join(cwd, ".env");
  if (existsSync(path)) process.loadEnvFile(path);
}

export function readLimits(env: NodeJS.ProcessEnv = process.env): BudgetLimits {
  return {
    maxCallsPerRun: positiveInt(env.FIBCHECK_MAX_CALLS_PER_RUN, DEFAULT_LIMITS.maxCallsPerRun, "FIBCHECK_MAX_CALLS_PER_RUN"),
    maxCallsTotal: positiveInt(env.FIBCHECK_MAX_CALLS_TOTAL, DEFAULT_LIMITS.maxCallsTotal, "FIBCHECK_MAX_CALLS_TOTAL"),
  };
}

/** Builds the shared model client for one run. Usage files live in `<cwd>/.fibcheck/`. */
export function createModelClient(runId: string, cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): ModelClient {
  if (!env.GEMINI_API_KEY && !env.GOOGLE_API_KEY) {
    throw new Error(
      "No Gemini API key found. Create one at https://aistudio.google.com/apikey and put it in .env as GEMINI_API_KEY=...",
    );
  }
  const gemini = new GeminiProvider({
    model: env.FIBCHECK_GEMINI_MODEL || undefined,
    fallbackModel: env.FIBCHECK_GEMINI_FALLBACK_MODEL || undefined,
  });
  const near = createNearProvider(cwd, env);
  const provider: ModelProvider = near ? new FallbackProvider(gemini, near) : gemini;
  const dir = join(cwd, ".fibcheck");
  const budget = new CallBudget(readLimits(env), runId, join(dir, "usage-totals.json"), join(dir, "usage-ledger.jsonl"));
  return new ModelClient(provider, budget);
}

function positiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive whole number.`);
  return value;
}
