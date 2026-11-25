import { networkInterfaces } from "node:os";
import { describe, expect, it } from "vitest";

import { DEFAULT_PORT, NO_UI_TEXT, resolvePort, serveMiniHost } from "../src/server.js";
import { filesIn, throwawayDir } from "./harness.js";

/**
 * The host answers on loopback and nowhere else. A single user app has no
 * auth, so an interface it listens on is an interface the library is
 * readable from. Lifted from Fellowship's serve.test.ts.
 */

function lanAddress(): string | null {
  for (const list of Object.values(networkInterfaces())) {
    for (const entry of list ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return null;
}

describe("serveMiniHost", () => {
  it("listens on 127.0.0.1 and nowhere else", async () => {
    const running = await serveMiniHost({ ...filesIn(throwawayDir()), port: 0 });

    try {
      expect(running.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

      const local = await fetch(`http://127.0.0.1:${running.port}/health`);
      expect(local.status).toBe(200);

      // From the machine's own network address, nothing answers.
      const lan = lanAddress();
      if (lan) {
        await expect(
          fetch(`http://${lan}:${running.port}/health`, { signal: AbortSignal.timeout(1500) }),
        ).rejects.toThrow();
      }
    } finally {
      await running.close();
    }
  });

  it("starts with no UI built and says so on /", async () => {
    const running = await serveMiniHost({ ...filesIn(throwawayDir()), port: 0 });
    try {
      const response = await fetch(`${running.url}/`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toMatch(/^text\/plain/);
      expect(await response.text()).toBe(NO_UI_TEXT);
    } finally {
      await running.close();
    }
  });

  it("defaults to its own port, not Fellowship's, unless REVERIE_PORT says otherwise", () => {
    expect(DEFAULT_PORT).toBe(4329);
    expect(resolvePort({})).toBe(4329);
    expect(resolvePort({ REVERIE_PORT: "4555" })).toBe(4555);
    expect(resolvePort({ REVERIE_PORT: "nope" })).toBe(4329);
    expect(resolvePort({ REVERIE_PORT: "4555" }, 0)).toBe(0);
  });
});
