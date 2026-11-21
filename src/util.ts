export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function newRunId(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
