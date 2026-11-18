import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ResolvedTarget } from "../target.js";

const exec = promisify(execFile);

export interface RunningApp {
  containerName: string;
  baseUrl: string;
  stop(): Promise<void>;
}

/**
 * Starts the target's Docker image with a fresh container, waits until it
 * answers, and returns a handle to stop it. Secrets go to Docker through
 * the environment of the `docker` process, never on its command line.
 */
export async function startApp(target: ResolvedTarget, runId: string, timeoutMs = 180_000): Promise<RunningApp> {
  const spec = target.app;
  if (!spec) throw new Error(`Target ${target.name} has no app section, so it can only be checked with --url.`);
  const containerName = `fibcheck-${target.name}-${runId}`.replace(/[^a-zA-Z0-9_.-]/g, "-");
  const envArgs = Object.keys(target.resolvedEnv).flatMap((key) => ["-e", key]);
  try {
    await exec(
      "docker",
      ["run", "-d", "--name", containerName, "-p", `${spec.port}:${spec.containerPort}`, ...envArgs, spec.image],
      { env: { ...process.env, ...target.resolvedEnv } },
    );
  } catch (error) {
    throw new Error(`Could not start ${spec.image} with Docker: ${firstLine(error)}`);
  }
  const app: RunningApp = {
    containerName,
    baseUrl: target.baseUrl,
    stop: async () => {
      await exec("docker", ["rm", "-f", containerName]).catch(() => undefined);
    },
  };
  try {
    await waitForHttp(`${target.baseUrl}${spec.readyPath ?? "/"}`, timeoutMs);
  } catch (error) {
    await app.stop();
    throw error;
  }
  return app;
}

export async function waitForHttp(url: string, timeoutMs: number, intervalMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: "follow" });
      if (response.ok) return;
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`The app did not answer at ${url} within ${Math.round(timeoutMs / 1000)} seconds.`);
}

function firstLine(error: unknown): string {
  const stderr = (error as { stderr?: string }).stderr;
  return (stderr || (error instanceof Error ? error.message : String(error))).split("\n").find((l) => l.trim()) ?? "unknown error";
}
