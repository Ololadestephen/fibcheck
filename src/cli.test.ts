import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { runCheck, type CheckReport } from "./check.js";
import { main } from "./cli.js";
import { createModelClient } from "./model/config.js";

vi.mock("./check.js", () => ({ runCheck: vi.fn() }));
vi.mock("./model/config.js", () => ({ createModelClient: vi.fn(() => ({})), loadDotEnv: vi.fn() }));

const LINKDING_TARGET = fileURLToPath(new URL("../targets/linkding.json", import.meta.url));
const emptyReport: CheckReport = {
  runId: "r", target: "t", repo: ".", commit: null, startedAt: "", finishedAt: "", documents: [], claims: [], rejected: [],
  tested: [], notTested: [], kaneCredits: 0, model: { calls: 0, inputTokens: 0, outputTokens: 0, cacheHits: 0 },
};

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

  it("rejects an attack --login without a {{NAME}} placeholder before doing any work", async () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(await main(["attack", "some-id", "--url", "http://localhost:9", "--login", "Sign in as admin with password hunter2"])).toBe(1);
      expect(String(write.mock.calls[0]?.[0])).toContain("--login must name its values as {{NAME}}");
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

  describe("check wiring", () => {
    const runCheckMock = vi.mocked(runCheck);

    it("gives runCheck the login values from the environment and the run id the model client got", async () => {
      vi.stubEnv("FIBCHECK_LOGIN_USER", "alice");
      vi.stubEnv("FIBCHECK_LOGIN_OTHER", "unused");
      runCheckMock.mockClear().mockResolvedValue(emptyReport);
      vi.mocked(createModelClient).mockClear();
      const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        expect(await main(["check", LINKDING_TARGET, "--url", "http://localhost:9", "--login", "Sign in as {{USER}}"])).toBe(0);
        const options = runCheckMock.mock.calls[0]![1];
        expect(options).toMatchObject({ appUrl: "http://localhost:9", login: "Sign in as {{USER}}", appRunningSecrets: { USER: "alice" } });
        expect(options.runId).toBe(vi.mocked(createModelClient).mock.calls[0]![0]);
        expect(out.mock.calls.map(([text]) => String(text)).join("")).toContain("Tested 0 claim(s).");
      } finally {
        out.mockRestore();
        vi.unstubAllEnvs();
      }
    });

    it("passes no login values when the app is started by fibcheck", async () => {
      runCheckMock.mockClear().mockResolvedValue(emptyReport);
      const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        expect(await main(["check", LINKDING_TARGET])).toBe(0);
        expect(runCheckMock.mock.calls[0]![1].appRunningSecrets).toBeUndefined();
      } finally {
        out.mockRestore();
      }
    });
  });
});
