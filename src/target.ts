import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * A target describes one web app to check: where its docs are, how to run it
 * locally, and how Kane logs in. Example files live in `targets/`.
 *
 * Secrets: write `{{secret:NAME}}` in `app.env`. Pinocchio generates a fresh
 * random value for each run, passes it to the container, and gives it to
 * Kane as a secret variable `NAME`, so `login` can say `{{NAME}}`.
 */
export interface Target {
  name: string;
  /** Git URL or local path of the repository whose docs are checked. */
  repo: string;
  /** Extra documentation files or folders inside the repository, besides the README and what it links to. */
  docs?: string[];
  app: {
    image: string;
    /** Port on this machine. */
    port: number;
    containerPort: number;
    env?: Record<string, string>;
    /** Path that returns HTTP 200 once the app is ready. */
    readyPath?: string;
  };
  /** Where Kane starts, relative to the app's base URL. */
  startPath?: string;
  /** Sentence telling Kane how to log in, using {{NAME}} for generated secrets. */
  login?: string;
}

export interface ResolvedTarget extends Target {
  baseUrl: string;
  /** Container environment with secrets filled in. Never logged. */
  resolvedEnv: Record<string, string>;
  /** Kane variables, all generated secrets, marked secret. Never logged. */
  kaneVariables: Record<string, { value: string; secret: boolean }>;
}

export function loadTarget(path: string): Target {
  const target = JSON.parse(readFileSync(path, "utf8")) as Target;
  for (const key of ["name", "repo", "app"] as const) {
    if (!target[key]) throw new Error(`Target ${path} is missing "${key}".`);
  }
  if (!target.app.image || !target.app.port || !target.app.containerPort) {
    throw new Error(`Target ${path} needs app.image, app.port and app.containerPort.`);
  }
  return target;
}

/** Fills in generated secrets for one run. */
export function resolveTarget(target: Target, generate: () => string = () => `Pk${randomBytes(12).toString("hex")}`): ResolvedTarget {
  const secrets = new Map<string, string>();
  const fill = (text: string) =>
    text.replace(/\{\{secret:([A-Za-z_][A-Za-z0-9_]*)\}\}/g, (_m, name: string) => {
      if (!secrets.has(name)) secrets.set(name, generate());
      return secrets.get(name) ?? "";
    });
  const resolvedEnv = Object.fromEntries(Object.entries(target.app.env ?? {}).map(([k, v]) => [k, fill(v)]));
  const kaneVariables = Object.fromEntries([...secrets].map(([name, value]) => [name, { value, secret: true }]));
  return { ...target, baseUrl: `http://localhost:${target.app.port}`, resolvedEnv, kaneVariables };
}
