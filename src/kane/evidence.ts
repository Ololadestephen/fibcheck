import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

/** One step's evidence, with paths relative to the run's evidence folder. */
export interface StepEvidence {
  ordinal: number;
  kind: string;
  status: string;
  summary: string;
  url: string;
  screenshot: string | null;
  annotated: string | null;
  /** Kane's failure record for this step, if it failed. */
  failureYaml: string | null;
}

/** Finds the evidence pack for a run: the path Kane reported, else the newest pack in the session folder. */
export function findEvidencePack(reported: string | null, sessionDir: string | null): string | null {
  if (reported && existsSync(reported)) return reported;
  if (!sessionDir) return null;
  const dir = join(sessionDir, "evidence");
  if (!existsSync(dir)) return null;
  const packs = readdirSync(dir).filter((f) => f.endsWith(".evidence"));
  return packs.length ? join(dir, packs.sort((a, b) => a.localeCompare(b)).at(-1) ?? "") : null;
}

/**
 * Unpacks the step screenshots and step records of a Kane evidence pack (a
 * zip file) into `destDir`, and lists them in step order. Uses the system
 * `unzip`, which macOS and GitHub's Linux runners include.
 */
export function extractStepEvidence(packPath: string, destDir: string): StepEvidence[] {
  execFileSync(
    "unzip",
    ["-o", "-q", packPath, "tests/*/steps/*", "-d", destDir],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const testsDir = join(destDir, "tests");
  if (!existsSync(testsDir)) return [];
  const steps: StepEvidence[] = [];
  for (const test of readdirSync(testsDir)) {
    const stepsDir = join(testsDir, test, "steps");
    if (!existsSync(stepsDir)) continue;
    for (const name of readdirSync(stepsDir)) steps.push(readStep(join(stepsDir, name), name, destDir));
  }
  return steps.sort((a, b) => a.ordinal - b.ordinal);
}

function readStep(dir: string, name: string, destDir: string): StepEvidence {
  const record = readJson(join(dir, "step.json"));
  const file = (f: string) => (existsSync(join(dir, f)) ? relative(destDir, join(dir, f)) : null);
  const failurePath = join(dir, "failure.yaml");
  return {
    ordinal: typeof record.ordinal === "number" ? record.ordinal : Number.parseInt(name, 10) || 0,
    kind: String(record.kind ?? ""),
    status: String(record.status ?? ""),
    summary: String(record.summary ?? ""),
    url: String(record.url ?? ""),
    screenshot: file("screenshot.jpg") ?? file("screenshot.png"),
    annotated: file("annotated.png"),
    failureYaml: existsSync(failurePath) ? readFileSync(failurePath, "utf8") : null,
  };
}

function readJson(path: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}
