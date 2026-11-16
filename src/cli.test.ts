import { describe, expect, it, vi } from "vitest";
import { main } from "./cli.js";

describe("cli", () => {
  it("prints usage and exits 0 for --help", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(await main(["--help"])).toBe(0);
    expect(String(write.mock.calls[0]?.[0])).toContain("Usage:");
    write.mockRestore();
  });

  it("exits 1 for an unknown command", async () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(await main(["nope"])).toBe(1);
    write.mockRestore();
  });
});
