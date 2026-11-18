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

  it("rejects negative or noninteger Kane run limits before loading a target", async () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(await main(["check", "missing-target", "--max-kane-runs=-1"])).toBe(1);
      expect(await main(["check", "missing-target", "--max-kane-runs", "1.5"])).toBe(1);
      expect(write.mock.calls).toEqual(Array(2).fill(["--max-kane-runs must be a whole number.\n"]));
    } finally {
      write.mockRestore();
    }
  });

  it("rejects --login without --url, and --url with --app-running, before loading a target", async () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(await main(["check", "missing-target", "--login", "Sign in as {{user}}."])).toBe(1);
      expect(await main(["check", "missing-target", "--url", "https://example.org", "--app-running"])).toBe(1);
      expect(write.mock.calls).toEqual([["--login needs --url.\n"], ["Use either --url or --app-running, not both.\n"]]);
    } finally {
      write.mockRestore();
    }
  });

  it("rejects a --login sentence without {{NAME}} values, so no password is typed into the command", async () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(await main(["check", "missing-target", "--url", "https://example.org", "--login", "Sign in as ada with password hunter2."])).toBe(1);
      expect(String(write.mock.calls[0]?.[0])).toContain("--login must name its values as {{NAME}}");
    } finally {
      write.mockRestore();
    }
  });

  it("describes --url in the help text", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await main(["--help"]);
    expect(String(write.mock.calls[0]?.[0])).toContain("--url checks an app that is already running there, with no Docker");
    write.mockRestore();
  });
});
