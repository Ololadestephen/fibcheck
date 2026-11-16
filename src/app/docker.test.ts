import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { waitForHttp } from "./docker.js";

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
