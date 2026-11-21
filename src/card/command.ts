#!/usr/bin/env node
import { existsSync, realpathSync } from "node:fs";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { writeCard } from "../card.js";
import { loadFindings } from "../findings.js";
import { errorMessage } from "../util.js";

export function cardCommand(args: string[]): number {
  try {
    const { values, positionals } = parseArgs({ args, allowPositionals: true,
      options: { all: { type: "boolean" }, findings: { type: "string" }, out: { type: "string" }, animate: { type: "boolean" } } });
    const findings = values.findings ?? "index/findings.json";
    const ids = values.all ? loadFindings(findings).map(({ id }) => id) : positionals;
    if (!ids.length) {
      process.stderr.write("Usage: fibcheck card <finding-id | --all> [--findings FILE] [--out DIR] [--animate]\n");
      return 1;
    }
    for (const id of ids) {
      const png = writeCard(findings, id, values.out ?? "index/cards", undefined, values.animate);
      process.stdout.write(`Saved ${png}\n`);
      if (values.animate) process.stdout.write(`Saved ${png.replace(/\.png$/, ".gif")}\n`);
    }
    return 0;
  } catch (error) {
    process.stderr.write(`fibcheck: ${errorMessage(error)}\n`);
    return 1;
  }
}

const executable = process.argv[1];
if (executable && existsSync(executable) && import.meta.url === pathToFileURL(realpathSync(executable)).href) {
  process.exitCode = cardCommand(process.argv.slice(2));
}
