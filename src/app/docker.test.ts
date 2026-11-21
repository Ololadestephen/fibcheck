import { execFile } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveTarget } from "../target.js";
import { startApp, waitForHttp } from "./docker.js";

vi.mock("node:child_process", () => ({
  execFile: vi.fn((...args: unknown[]) => {
    const callback = args.at(-1) as (error: Error | null, result: { stdout: string; stderr: string }) => void;
    callback(null, { stdout: "", stderr: "" });
  }),
}));

describe("waitForHttp", () => {
  it("waits until the app answers with HTTP 200", async () => {
    let requests = 0;
    const server = createServer((_req, res) => {
      requests++;
      res.statusCode = requests < 3 ? 503 : 200;
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      await waitForHttp(`http://127.0.0.1:${port}/ready`, 5_000, 10);
      expect(requests).toBe(3);
    } finally {
      server.close();
    }
  });

  it("gives up with a clear message", async () => {
    await expect(waitForHttp("http://127.0.0.1:9/", 50, 10)).rejects.toThrow(/did not answer/);
  });
});

describe("startApp", () => {
  const target = resolveTarget({
    name: "my app/1", repo: ".",
    app: { image: "example/app:1", port: 8123, containerPort: 80, env: { ADMIN_PASSWORD: "{{secret:pass}}", MODE: "test" } },
  }, () => "s3cret-value");
  const calls = () => vi.mocked(execFile).mock.calls as unknown as [string, string[], { env?: NodeJS.ProcessEnv }?][];

  afterEach(() => {
    vi.mocked(execFile).mockClear();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("passes secrets only through the docker process environment and sanitises the container name", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok")));
    const app = await startApp(target, "2026-11-17T10:00:00.000Z");
    expect(app.containerName).toBe("fibcheck-my-app-1-2026-11-17T10-00-00.000Z");
    const [file, args, options] = calls()[0]!;
    expect(file).toBe("docker");
    expect(args).toEqual(["run", "-d", "--name", app.containerName, "-p", "8123:80", "-e", "ADMIN_PASSWORD", "-e", "MODE", "example/app:1"]);
    expect(args.join(" ")).not.toContain("s3cret-value");
    expect(options?.env?.ADMIN_PASSWORD).toBe("s3cret-value");
  });

  it("removes the container and rethrows when the app never becomes ready", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("refused"); }));
    const started = startApp(target, "run", 30);
    const outcome = expect(started).rejects.toThrow(/did not answer at http:\/\/localhost:8123\//);
    await vi.advanceTimersByTimeAsync(5_000);
    await outcome;
    expect(calls().at(-1)!.slice(0, 2)).toEqual(["docker", ["rm", "-f", "fibcheck-my-app-1-run"]]);
  });
});
