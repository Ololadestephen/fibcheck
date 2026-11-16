import { existsSync } from "node:fs";
import { join } from "node:path";
import { CallBudget, type BudgetLimits } from "./budget.js";
import { ModelClient } from "./client.js";
import { GeminiProvider } from "./gemini.js";

export const DEFAULT_LIMITS: BudgetLimits = { maxCallsPerRun: 60, maxCallsTotal: 1500 };

/** Loads `.env` from the working directory if present. Values are never printed. */
export function loadDotEnv(cwd = process.cwd()): void {
  const path = join(cwd, ".env");
  if (existsSync(path)) process.loadEnvFile(path);
}

export function readLimits(env: NodeJS.ProcessEnv = process.env): BudgetLimits {
  return {
    maxCallsPerRun: positiveInt(env.PINOCCHIO_MAX_CALLS_PER_RUN, DEFAULT_LIMITS.maxCallsPerRun, "PINOCCHIO_MAX_CALLS_PER_RUN"),
    maxCallsTotal: positiveInt(env.PINOCCHIO_MAX_CALLS_TOTAL, DEFAULT_LIMITS.maxCallsTotal, "PINOCCHIO_MAX_CALLS_TOTAL"),
  };
}

/** Builds the shared model client for one run. Usage files live in `<cwd>/.pinocchio/`. */
export function createModelClient(runId: string, cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): ModelClient {
  if (!env.GEMINI_API_KEY && !env.GOOGLE_API_KEY) {
    throw new Error(
      "No Gemini API key found. Create one at https://aistudio.google.com/apikey and put it in .env as GEMINI_API_KEY=...",
    );
  }
  const provider = new GeminiProvider({
    model: env.PINOCCHIO_GEMINI_MODEL || undefined,
    fallbackModel: env.PINOCCHIO_GEMINI_FALLBACK_MODEL || undefined,
  });
  const dir = join(cwd, ".pinocchio");
  const budget = new CallBudget(readLimits(env), runId, join(dir, "usage-totals.json"), join(dir, "usage-ledger.jsonl"));
  return new ModelClient(provider, budget);
}

function positiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive whole number.`);
  return value;
}
