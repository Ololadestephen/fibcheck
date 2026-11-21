import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedTarget } from "../target.js";

export function escapeKaneBraces(text: string): string {
  return text.replace(/[{}]{2,}/g, (braces) => braces.split("").join(" "));
}

export function writeKaneVariables(variables: ResolvedTarget["kaneVariables"]) {
  if (Object.keys(variables).length === 0) return undefined;
  const directory = mkdtempSync(join(tmpdir(), "fibcheck-kane-"));
  const path = join(directory, "variables.json");
  const remove = () => rmSync(directory, { recursive: true, force: true });
  try {
    writeFileSync(path, JSON.stringify(variables), { flag: "wx", mode: 0o600 });
  } catch (error) {
    remove();
    throw error;
  }
  return { path, remove };
}

/**
 * Documentation often names its own default address (for example http://localhost:5230). The test app runs
 * elsewhere and Kane already starts on it, so a local address in a check is replaced by a reference to the app.
 */
export function localAddressesToApp(check: string): string {
  return check.replace(/\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?(\/[^\s"'<>]*)?/gi, (_match, path: string | undefined) => (
    path && path !== "/" ? `the app's ${path.replace(/[.,;:]+$/, "")} page` : "the app's start page"
  ));
}
