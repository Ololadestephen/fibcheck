#!/usr/bin/env node
import { pathToFileURL } from "node:url";

export const USAGE = `pinocchio: finds the false claims in a web app's README with Kane CLI.

Usage:
  pinocchio check <repository path or URL>   (not built yet)
  pinocchio --help
`;

export function main(argv: string[]): number {
  const [command] = argv;
  if (command === undefined || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return 0;
  }
  process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
