import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * A target describes one web app to check: where its docs are, how to run it
 * locally, and how Kane logs in. Example files live in `targets/`.
 *
 * Secrets: write `{{secret:NAME}}` in `app.env`. fibcheck generates a fresh
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
  /** Sentence telling Kane how to log in, using {{NAME}} for secret variables. */
  login?: string;
}

export interface ResolvedTarget extends Target {
  baseUrl: string;
  /** Container environment with secrets filled in. Never logged. */
  resolvedEnv: Record<string, string>;
  /** Generated Kane variables. Never logged. */
  kaneVariables: Record<string, { value: string; secret: boolean }>;
}

export function runningAppVariables(
  login: Target["login"], secrets: Readonly<Record<string, string>>,
): ResolvedTarget["kaneVariables"] {
  const names = new Set(Array.from((login ?? "").matchAll(/\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g), (match) => match[1]!));
  return Object.fromEntries(Array.from(names, (name) => {
    const value = Object.hasOwn(secrets, name) ? secrets[name] : undefined;
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`Missing Kane login variable "${name}" for the running app. Supply it through appRunningSecrets.`);
    }
    return [name, { value, secret: true }];
  }));
}

export function targetPathFor(input: string): string {
  if (existsSync(input)) return input;
  if (input === "sissbruecker/linkding" || isLinkdingRepo(input)) {
    return fileURLToPath(new URL("../targets/linkding.json", import.meta.url));
  }
  throw new Error("No target file or bundled repository matches the input. Pass a target JSON file for a custom app.");
}

export function isLinkdingRepo(repo: string): boolean {
  if (!URL.canParse(repo)) return false;
  const url = new URL(repo);
  return url.protocol === "https:" && url.host === "github.com"
    && !url.username && !url.password && !url.search && !url.hash
    && url.pathname.replace(/\/$/, "").replace(/\.git$/, "") === "/sissbruecker/linkding";
}

export function loadTarget(path: string): Target {
  let target: Target;
  try {
    target = JSON.parse(readFileSync(path, "utf8")) as Target;
  } catch (error) {
    throw new Error(`Could not read target ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
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
