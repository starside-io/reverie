import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { REFUSED_HOST, REFUSED_ORIGIN, REFUSED_TYPE } from "../src/guard.js";
import { NO_UI_TEXT, createApp, serveMiniHost } from "../src/server.js";
import { filesIn, remember, throwawayDir, throwawayHost } from "./harness.js";

/**
 * The built UI, served by the host (docs/SPEC.md section 20), and the guard
 * that keeps a page on another origin from driving /rpc as the owner. The
 * "build" here is a throwaway folder with an index.html and one asset, so the
 * test never depends on packages/ui having been built.
 */

const INDEX = '<!doctype html><html><head><title>Reverie</title></head><body><div id="root"></div><script type="module" src="/assets/app.js"></script></body></html>';

function builtUi(): string {
  const dir = mkdtempSync(join(tmpdir(), "reverie-ui-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), INDEX);
  writeFileSync(join(dir, "assets", "app.js"), "console.log('app');\n");
  writeFileSync(join(dir, "favicon.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
  return dir;
}

const HTML = { accept: "text/html,application/xhtml+xml" };

describe("the built UI", () => {
  it("is served at / and its assets are served with a long cache", async () => {
    const host = await throwawayHost();
    try {
      const app = createApp(host, { uiDir: builtUi() });
      const page = await app.request("/", { headers: HTML });
      expect(page.status).toBe(200);
      expect(await page.text()).toBe(INDEX);

      const asset = await app.request("/assets/app.js");
      expect(asset.status).toBe(200);
      expect(asset.headers.get("cache-control")).toMatch(/immutable/);
      expect(await asset.text()).toContain("console.log");

      expect((await app.request("/favicon.svg")).status).toBe(200);
    } finally {
      await host.close();
    }
  });

  it("falls back to index.html for a deep link, so it opens the right screen", async () => {
    const host = await throwawayHost();
    try {
      const app = createApp(host, { uiDir: builtUi() });
      for (const path of ["/memory/LIF/GTH/2026-12-24/001", "/library/LIF/GTH", "/review", "/recall", "/desk"]) {
        const response = await app.request(path, { headers: HTML });
        expect(response.status, path).toBe(200);
        expect(await response.text(), path).toBe(INDEX);
      }
    } finally {
      await host.close();
    }
  });

  it("answers a missing file with a 404 rather than the page, and keeps its own routes", async () => {
    const host = await throwawayHost();
    try {
      const app = createApp(host, { uiDir: builtUi() });
      expect((await app.request("/assets/missing.js")).status).toBe(404);
      expect((await app.request("/memory/LIF/GTH/2026-12-24/001", { headers: { accept: "application/json" } })).status).toBe(404);

      const health = await app.request("/health", { headers: HTML });
      expect(((await health.json()) as { tools: number }).tools).toBe(41);
      const review = await app.request("/host/review", { headers: HTML });
      expect(review.headers.get("content-type")).toMatch(/json/);
      const tools = await app.request("/rpc", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tool: "memory.tags" }),
      });
      expect(((await tools.json()) as { ok: boolean }).ok).toBe(true);
    } finally {
      await host.close();
    }
  });

  it("says plainly that the UI is not built when there is no build", async () => {
    const host = await throwawayHost();
    try {
      const missing = createApp(host, { uiDir: join(throwawayDir(), "nowhere") });
      expect(await (await missing.request("/", { headers: HTML })).text()).toBe(NO_UI_TEXT);
      expect(NO_UI_TEXT).toMatch(/not built/);
    } finally {
      await host.close();
    }
  });

  it("is found by serveMiniHost from the option or REVERIE_UI_DIR, on a real socket", async () => {
    const dir = builtUi();
    const running = await serveMiniHost({
      ...filesIn(throwawayDir()),
      port: 0,
      lock: false,
      env: { ...process.env, REVERIE_UI_DIR: dir },
    });
    try {
      const response = await fetch(`${running.url}/memory/WRK/NST/2026-11-10/001`, { headers: HTML });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(INDEX);
    } finally {
      await running.close();
    }
  });
});

describe("the owner guard", () => {
  const rpcBody = (tool: string, input: unknown = {}) => JSON.stringify({ tool, input });

  it("refuses a write from a page on another origin, and writes nothing", async () => {
    const host = await throwawayHost();
    try {
      const app = createApp(host);
      const refused = await app.request("/rpc", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://pages.example" },
        body: rpcBody("memory.remember", { kind: "fact", shelf: "LIF/HOM", body: "Planted by another page." }),
      });
      expect(refused.status).toBe(403);
      expect(await refused.json()).toEqual({ ok: false, tool: "", error: { code: "refused", message: REFUSED_ORIGIN } });
      expect(await host.silo.memory.count()).toBe(0);

      const decision = await app.request("/host/review/anything/confirm", {
        method: "POST",
        headers: { origin: "https://pages.example" },
      });
      expect(decision.status).toBe(403);

      const marked = await app.request("/rpc", {
        method: "POST",
        headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" },
        body: rpcBody("memory.tags"),
      });
      expect(marked.status).toBe(403);
    } finally {
      await host.close();
    }
  });

  it("lets the UI on its own origin through, and a client with no Origin (curl, the CLI)", async () => {
    const host = await throwawayHost();
    try {
      const app = createApp(host);
      const same = await app.request("http://localhost/rpc", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost", "sec-fetch-site": "same-origin" },
        body: rpcBody("memory.remember", { kind: "fact", shelf: "LIF/HOM", body: "The spare key hangs by the back door in Elmwood." }),
      });
      expect(same.status).toBe(200);
      const none = await app.request("/rpc", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: rpcBody("memory.tags"),
      });
      expect(none.status).toBe(200);
      expect(await host.silo.memory.count()).toBe(1);
    } finally {
      await host.close();
    }
  });

  it("takes /rpc as JSON only, so a browser can never send it without a preflight", async () => {
    const host = await throwawayHost();
    try {
      const response = await createApp(host).request("/rpc", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: rpcBody("memory.tags"),
      });
      expect(response.status).toBe(415);
      expect(((await response.json()) as { error: { message: string } }).error.message).toBe(REFUSED_TYPE);
    } finally {
      await host.close();
    }
  });

  it("answers no host name but loopback, so a rebinding page is refused, reads included", async () => {
    const host = await throwawayHost();
    try {
      await remember(host, { shelf: "LIF/HOM", body: "The spare key hangs by the back door in Elmwood." });
      const app = createApp(host, { uiDir: builtUi() });
      for (const [path, init] of [
        ["http://rebound.example:4329/health", {}],
        ["http://rebound.example:4329/host/review", {}],
        ["http://rebound.example:4329/", { headers: HTML }],
        [
          "http://rebound.example:4329/rpc",
          { method: "POST", headers: { "content-type": "application/json" }, body: rpcBody("memory.browse", { shelf: "LIF/HOM" }) },
        ],
      ] as const) {
        const response = await app.request(path, init);
        expect(response.status, path).toBe(403);
        expect(await response.text(), path).toContain(REFUSED_HOST);
      }
      for (const name of ["127.0.0.1", "localhost", "[::1]"]) {
        expect((await app.request(`http://${name}:4329/health`)).status, name).toBe(200);
      }
    } finally {
      await host.close();
    }
  });
});
