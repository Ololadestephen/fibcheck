import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative, sep } from "node:path";
import type { SourceDocument } from "./types.js";

const README_NAMES = ["README.md", "readme.md", "Readme.md", "README.markdown", "README"];

/** At most this many linked documents are read, to keep model use bounded. */
export const MAX_LINKED_DOCS = 10;

/**
 * Collects the documents to check in a local repository: the README, the
 * Markdown files it links to inside the repository, and any extra files or
 * folders the user names. Paths in the result are relative to the repository.
 */
export function collectDocuments(repoDir: string, extra: string[] = []): SourceDocument[] {
  const readme = README_NAMES.map((name) => join(repoDir, name)).find((path) => existsSync(path));
  if (!readme) throw new Error(`No README found in ${repoDir}.`);

  const paths = new Set<string>([readme]);
  for (const linked of linkedMarkdown(readme, repoDir).slice(0, MAX_LINKED_DOCS)) paths.add(linked);
  for (const item of extra) {
    for (const path of expand(join(repoDir, item))) paths.add(path);
  }
  return [...paths].map((path) => ({ file: toPosix(relative(repoDir, path)), content: readFileSync(path, "utf8") }));
}

/** Relative links from a Markdown file to other Markdown files inside the repository. */
export function linkedMarkdown(file: string, repoDir: string): string[] {
  const text = readFileSync(file, "utf8");
  const found: string[] = [];
  for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = (match[1] ?? "").split("#")[0] ?? "";
    if (!target || /^[a-z]+:/i.test(target) || target.startsWith("/")) continue;
    if (!/\.(md|mdx|markdown)$/i.test(target)) continue;
    const path = normalize(join(dirname(file), target));
    if (!path.startsWith(normalize(repoDir) + sep)) continue;
    if (existsSync(path) && !found.includes(path)) found.push(path);
  }
  return found;
}

function expand(path: string): string[] {
  if (!existsSync(path)) throw new Error(`Document not found: ${path}`);
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path, { recursive: true, encoding: "utf8" })
    .filter((name) => /\.(md|mdx|markdown)$/i.test(name))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => join(path, name));
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}
