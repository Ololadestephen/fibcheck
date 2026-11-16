import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { TokenUsage } from "./types.js";

/** Limits on model use. On the Gemini free tier these are call counts, not dollars. */
export interface BudgetLimits {
  maxCallsPerRun: number;
  maxCallsTotal: number;
}

/** Raised before a call is made when it would go over a limit. */
export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

interface TotalsFile {
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

/** One line of the usage ledger. Holds no prompt text, keys or responses. */
export interface LedgerEntry {
  at: string;
  runId: string;
  purpose: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  ok: boolean;
}

/**
 * Counts model calls for one run and across all runs, and refuses a call
 * that would exceed either limit. The all-runs total is kept in a small
 * JSON file so the limit holds across separate commands.
 */
export class CallBudget {
  private runCalls = 0;
  private runUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

  constructor(
    private readonly limits: BudgetLimits,
    private readonly runId: string,
    private readonly totalsPath: string,
    private readonly ledgerPath: string,
  ) {}

  /** Reserves one call, or throws if a limit would be exceeded. */
  reserve(): void {
    if (this.runCalls >= this.limits.maxCallsPerRun) {
      throw new BudgetExceededError(
        `Model call limit for this run reached (${this.limits.maxCallsPerRun} calls).`,
      );
    }
    const totals = this.readTotals();
    if (totals.calls >= this.limits.maxCallsTotal) {
      throw new BudgetExceededError(
        `Total model call limit reached (${this.limits.maxCallsTotal} calls). Raise PINOCCHIO_MAX_CALLS_TOTAL to continue.`,
      );
    }
    this.runCalls += 1;
    this.writeTotals({ ...totals, calls: totals.calls + 1 });
  }

  /** Records the outcome of a reserved call in the ledger and the totals. */
  record(entry: Omit<LedgerEntry, "at" | "runId">): void {
    this.runUsage = {
      inputTokens: this.runUsage.inputTokens + entry.inputTokens,
      outputTokens: this.runUsage.outputTokens + entry.outputTokens,
    };
    const totals = this.readTotals();
    this.writeTotals({
      calls: totals.calls,
      inputTokens: totals.inputTokens + entry.inputTokens,
      outputTokens: totals.outputTokens + entry.outputTokens,
    });
    const line: LedgerEntry = { at: new Date().toISOString(), runId: this.runId, ...entry };
    ensureDir(this.ledgerPath);
    appendFileSync(this.ledgerPath, `${JSON.stringify(line)}\n`);
  }

  /** Calls and tokens used so far in this run. */
  runSummary(): { calls: number } & TokenUsage {
    return { calls: this.runCalls, ...this.runUsage };
  }

  private readTotals(): TotalsFile {
    if (!existsSync(this.totalsPath)) return { calls: 0, inputTokens: 0, outputTokens: 0 };
    try {
      return JSON.parse(readFileSync(this.totalsPath, "utf8")) as TotalsFile;
    } catch {
      // Refuse rather than reset: resetting would silently lift the total limit.
      throw new BudgetExceededError(
        `The usage totals file ${this.totalsPath} is damaged. Fix or delete it on purpose before making more model calls.`,
      );
    }
  }

  private writeTotals(totals: TotalsFile): void {
    ensureDir(this.totalsPath);
    writeFileSync(this.totalsPath, `${JSON.stringify(totals, null, 2)}\n`);
  }
}

function ensureDir(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}
