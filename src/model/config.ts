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

/** Dollar cap for a user-chosen model with known prices, unless FIBCHECK_MODEL_MAX_USD says otherwise. */
export const DEFAULT_MODEL_MAX_USD = 1;

/**
 * Any OpenAI-compatible model the user chooses with FIBCHECK_MODEL_BASE_URL, FIBCHECK_MODEL_API_KEY and
 * FIBCHECK_MODEL (OpenAI, NEAR AI, OpenRouter, a local Ollama server and others). It replaces Gemini.
 * With FIBCHECK_MODEL_PRICE_INPUT and FIBCHECK_MODEL_PRICE_OUTPUT (dollars per million tokens) a dollar cap
 * applies; without them only the call cap does, and the report says so.
 */
export function createModelFromEnv(cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): OpenAICompatibleProvider | undefined {
  const baseUrl = env.FIBCHECK_MODEL_BASE_URL;
  if (!baseUrl) return undefined;
  if (!URL.canParse(baseUrl) || !/^https?:$/.test(new URL(baseUrl).protocol)) {
    throw new Error("FIBCHECK_MODEL_BASE_URL must be an http or https address, such as https://api.openai.com/v1.");
  }
  const model = env.FIBCHECK_MODEL;
  if (!model) throw new Error("FIBCHECK_MODEL_BASE_URL is set, so FIBCHECK_MODEL must name the model, such as gpt-4.1-mini.");
  const host = new URL(baseUrl).hostname;
  const local = host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".localhost");
  if (!env.FIBCHECK_MODEL_API_KEY && !local) {
    throw new Error(`FIBCHECK_MODEL_API_KEY is missing for ${host}. Only a model on this machine (such as Ollama) can run without a key.`);
  }
  const prices = readPrices(env);
  return new OpenAICompatibleProvider({
    label: host,
    baseUrl,
    apiKey: env.FIBCHECK_MODEL_API_KEY || undefined,
    model,
    prices,
    maxUsd: prices ? positiveNumber(env.FIBCHECK_MODEL_MAX_USD, DEFAULT_MODEL_MAX_USD, "FIBCHECK_MODEL_MAX_USD") : undefined,
    spendPath: prices ? join(cwd, ".fibcheck", "model-spend.json") : undefined,
  });
}

function readPrices(env: NodeJS.ProcessEnv): { inputPerMillion: number; outputPerMillion: number } | undefined {
  const input = env.FIBCHECK_MODEL_PRICE_INPUT;
  const output = env.FIBCHECK_MODEL_PRICE_OUTPUT;
  if (!input && !output) return undefined;
  if (!input || !output) throw new Error("Set both FIBCHECK_MODEL_PRICE_INPUT and FIBCHECK_MODEL_PRICE_OUTPUT, or neither.");
  return {
    inputPerMillion: positiveNumber(input, 0, "FIBCHECK_MODEL_PRICE_INPUT", true),
    outputPerMillion: positiveNumber(output, 0, "FIBCHECK_MODEL_PRICE_OUTPUT", true),
  };
}

function positiveNumber(raw: string | undefined, fallback: number, name: string, allowZero = false): number {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || (!allowZero && value === 0)) throw new Error(`${name} must be a positive number of US dollars.`);
  return value;
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
  const dir = join(cwd, ".fibcheck");
  const budget = new CallBudget(readLimits(env), runId, join(dir, "usage-totals.json"), join(dir, "usage-ledger.jsonl"));
  const chosen = createModelFromEnv(cwd, env);
  if (chosen) return new ModelClient(chosen, budget);
  if (!env.GEMINI_API_KEY && !env.GOOGLE_API_KEY) {
    throw new Error(
      "No model is configured. Put GEMINI_API_KEY=... in .env (a free key from https://aistudio.google.com/apikey), " +
        "or choose any OpenAI-compatible model with FIBCHECK_MODEL_BASE_URL, FIBCHECK_MODEL_API_KEY and FIBCHECK_MODEL.",
    );
  }
  const gemini = new GeminiProvider({
    apiKey: env.GOOGLE_API_KEY || env.GEMINI_API_KEY,
    model: env.FIBCHECK_GEMINI_MODEL || undefined,
    fallbackModel: env.FIBCHECK_GEMINI_FALLBACK_MODEL || undefined,
  });
  const near = createNearProvider(cwd, env);
  const provider: ModelProvider = near ? new FallbackProvider(gemini, near) : gemini;
  return new ModelClient(provider, budget);
}

function positiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive whole number.`);
  return value;
}
