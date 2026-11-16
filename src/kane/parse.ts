/**
 * Parses the NDJSON that `kane-cli run --agent` prints. Field names come
 * from real Kane CLI 0.10.4 output saved in T1 (see fixtures/kane/).
 * Unknown lines and fields are ignored, as Kane's docs ask.
 */

/** passed/failed come from Kane; error = did not start (exit 2); cancelled = timeout or cancel (exit 3). */
export type KaneStatus = "passed" | "failed" | "error" | "cancelled";

export interface KaneStep {
  step: number;
  status: "done" | "failed";
  remark: string;
}

/** Kane's own guess at who is at fault. A hypothesis for the questioning loop, never a verdict. */
export interface KaneBlame {
  family: string;
  category: string;
  rootCause: string;
  confidence: number | null;
  agentFaultAssessment: string;
}

/** One value Kane extracted and compared while checking a condition. */
export interface KaneObservation {
  name: string;
  condition: string;
  extractedValue: string;
  expectedValue: string;
  analyzerType?: string;
  usedDomCode?: boolean;
}

export interface KaneResult {
  status: KaneStatus;
  exitCode: number;
  oneLiner: string;
  summary: string;
  reason: string;
  reasonCode: string;
  durationSec: number | null;
  credits: number | null;
  testUrl: string | null;
  sessionDir: string | null;
  evidencePack: string | null;
  steps: KaneStep[];
  /** The last step Kane marked failed, if any. */
  failedStep: KaneStep | null;
  observations: KaneObservation[];
  blame: KaneBlame | null;
  /** Lines of stdout that were not JSON or not understood; kept for debugging. */
  ignoredLines: number;
}

type Json = Record<string, unknown>;

interface StreamState {
  steps: Map<number, KaneStep>;
  end?: Json;
  pack: string | null;
  errorMessage: string;
  ignoredLines: number;
}

function readStream(stdout: string): StreamState {
  const state: StreamState = { steps: new Map(), pack: null, errorMessage: "", ignoredLines: 0 };
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      applyEvent(state, JSON.parse(line) as Json);
    } catch {
      state.ignoredLines++;
    }
  }
  return state;
}

function applyEvent(state: StreamState, obj: Json): void {
  if (typeof obj.step === "number" && (obj.status === "done" || obj.status === "failed")) {
    state.steps.set(obj.step, { step: obj.step, status: obj.status, remark: str(obj.remark) });
  } else if (obj.type === "run_end") {
    state.end = obj;
  } else if (obj.type === "coverage" && typeof obj.pack === "string") {
    state.pack = obj.pack;
  } else if (obj.type === "error") {
    state.errorMessage = str(obj.message);
  }
}

export function parseKaneOutput(stdout: string, exitCode: number): KaneResult {
  const { steps, end, pack, errorMessage, ignoredLines } = readStream(stdout);
  const stepList = [...steps.values()].sort((a, b) => a.step - b.step);
  const failed = stepList.filter((s) => s.status === "failed");
  return {
    status: statusFrom(exitCode, end),
    exitCode,
    oneLiner: str(end?.one_liner) || errorMessage,
    summary: str(end?.summary),
    reason: str(end?.reason) || errorMessage || inconclusiveReason(exitCode, end),
    reasonCode: str(end?.reason_code),
    durationSec: num(end?.duration),
    credits: num(end?.credits_consumed) ?? num(end?.credits),
    testUrl: str(end?.test_url) || null,
    sessionDir: str(end?.session_dir) || null,
    evidencePack: pack,
    steps: stepList,
    failedStep: failed[failed.length - 1] ?? null,
    observations: observationsFrom(end),
    blame: blameFrom(end),
    ignoredLines,
  };
}

function statusFrom(exitCode: number, end: Json | undefined): KaneStatus {
  if (exitCode === 2) return "error";
  if (exitCode === 3) return "cancelled";
  if (end?.status === "passed" && exitCode === 0) return "passed";
  if (end?.status === "failed") return "failed";
  // A pass with a non-zero exit (Kane's docs: exit 1 can mean the upload failed) is
  // inconclusive. Reporting it as a failure could lead to a false accusation.
  return "error";
}

function inconclusiveReason(exitCode: number, end: Json | undefined): string {
  if (end?.status === "passed" && exitCode !== 0) return `Kane reported a pass but exited with code ${exitCode}; treated as inconclusive.`;
  return end ? "" : `Kane ended without a result (exit code ${exitCode}).`;
}

function observationsFrom(end: Json | undefined): KaneObservation[] {
  const memory = (end?.context as Json | undefined)?.memory as Record<string, Json> | undefined;
  if (!memory || typeof memory !== "object") return [];
  return Object.entries(memory).map(([name, m]) => ({
    name,
    condition: str(m.condition),
    extractedValue: str(m.extracted_value),
    expectedValue: str(m.expected_value),
    analyzerType: str(m.analyzer_type),
    usedDomCode: Boolean(m.code_js || m.wrapped_js || (Array.isArray(m.locators) ? m.locators.length : m.locators)),
  }));
}

function blameFrom(end: Json | undefined): KaneBlame | null {
  const v = end?.verdict as Json | undefined;
  if (!v || typeof v !== "object" || !v.family) return null;
  return {
    family: str(v.family),
    category: str(v.category),
    rootCause: str(v.root_cause),
    confidence: num(v.confidence),
    agentFaultAssessment: str(v.agent_fault_assessment),
  };
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
