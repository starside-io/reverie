import { describe, expect, it } from "vitest";

import { createApp, serveMiniHost } from "../src/server.js";
import { auditText, filesIn, remember, throwawayDir, throwawayHost } from "./harness.js";

/**
 * POST /rpc: the one way in, and the only one a UI will have. Everything
 * here goes through the same registry the MCP server uses, so a refusal reads
 * the same from both and neither gets a privileged path. Lifted from
 * Fellowship's rpc.test.ts.
 */

type Json = Record<string, unknown>;

async function post(app: ReturnType<typeof createApp>, body: unknown) {
  const response = await app.request("/rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Json };
}

const BODY = "The spare key hangs by the back door of the cottage in Elmwood.";

describe("the HTTP surface", () => {
  it("answers /health with where the files are", async () => {
    const host = await throwawayHost();
    try {
      const response = await createApp(host).request("/health");
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: true,
        silo: host.siloPath,
        hostDb: host.hostPath,
        tools: 41,
        pid: process.pid,
      });
    } finally {
      await host.close();
    }
  });

  it("lists the tool surface for a client building a palette", async () => {
    const host = await throwawayHost();
    try {
      const response = await createApp(host).request("/rpc/tools");
      const body = (await response.json()) as { tools: Array<{ name: string; kind: string }> };
      expect(body.tools).toHaveLength(41);
      expect(body.tools.filter((tool) => tool.kind === "needs-ok")).toHaveLength(6);
      expect(body.tools.every((tool) => tool.name.startsWith("memory."))).toBe(true);
    } finally {
      await host.close();
    }
  });
});

describe("remember and recall over HTTP", () => {
  it("writes, finds, and abstains, on a real socket", async () => {
    const running = await serveMiniHost({ ...filesIn(throwawayDir()), port: 0 });
    const call = async (tool: string, input: Json) => {
      const response = await fetch(`${running.url}/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tool, input }),
      });
      return { status: response.status, body: (await response.json()) as Json };
    };

    try {
      const written = await call("memory.remember", { kind: "fact", shelf: "LIF/HOM", body: BODY, tags: ["home"] });
      expect(written.status).toBe(200);
      const memory = (written.body.result as { memory: { call: string } }).memory;
      expect(memory.call).toMatch(/^LIF\/HOM\/\d{4}-\d{2}-\d{2}\/001$/);

      const hit = await call("memory.recall", { query: "spare key back door" });
      expect(hit.status).toBe(200);
      const found = hit.body.result as { sufficient: boolean; items: Array<{ call: string }> };
      expect(found.sufficient).toBe(true);
      expect(found.items.map((item) => item.call)).toEqual([memory.call]);

      const miss = await call("memory.recall", { query: "submarine telescope" });
      expect(miss.body.result).toEqual({ items: [], sufficient: false });

      // The audit line went to host.db, and holds no memory text.
      expect(running.host.store.listAudit().map((entry) => entry.tool)).toEqual([
        "memory.recall",
        "memory.recall",
        "memory.remember",
      ]);
      expect(auditText(running.host)).not.toContain("spare key");
    } finally {
      await running.close();
    }
  });
});

describe("a call over /rpc", () => {
  it("gives a refusal its own status code and keeps the message", async () => {
    const host = await throwawayHost();
    const app = createApp(host);
    try {
      const made = await remember(host, { shelf: "LIF/HOM", body: BODY });

      const unknown = await post(app, { tool: "memory.nope", input: {} });
      expect(unknown.status).toBe(404);
      expect(unknown.body).toMatchObject({ ok: false, error: { code: "unknown_tool" } });

      // A needs-ok tool without the owner's yes is invalid input, and nothing goes.
      const unconfirmed = await post(app, { tool: "memory.forget", input: { call: made.memory.call } });
      expect(unconfirmed.status).toBe(400);
      expect(unconfirmed.body).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      expect(await host.silo.memory.count()).toBe(1);

      const missing = await post(app, { tool: "memory.get", input: { call: "LIF/HOM/2026-01-01/009" } });
      expect(missing.status).toBe(404);
      expect(missing.body).toMatchObject({ ok: false, error: { code: "not_found" } });

      const procedure = await post(app, {
        tool: "memory.remember",
        input: { kind: "procedure", body: "Always write tests first." },
      });
      expect(procedure.status).toBe(409);
      expect(procedure.body).toMatchObject({ ok: false, error: { code: "refused" } });

      const noTool = await post(app, { input: {} });
      expect(noTool.status).toBe(400);

      const notJson = await app.request("/rpc", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not json",
      });
      expect(notJson.status).toBe(400);
    } finally {
      await host.close();
    }
  });

  it("has no route that reaches the silo without a tool", async () => {
    const host = await throwawayHost();
    const app = createApp(host);
    try {
      for (const path of ["/memories", "/silo", "/db", "/query", "/sql", "/media"]) {
        const response = await app.request(path);
        expect(response.status, path).toBe(404);
      }
    } finally {
      await host.close();
    }
  });
});

describe("the review queue", () => {
  it("lists what an assistant proposed and takes one decision per row", async () => {
    const host = await throwawayHost();
    const app = createApp(host);
    try {
      const said = "We met Sam Rivera for coffee at the station cafe in Elmwood.";
      const context = (await host.api.invoke("memory.draft_context", {
        job: "extract",
        material: { kind: "turns", turns: [{ role: "user", text: said }] },
        sessionDate: "2026-12-27",
      })) as { target: unknown };
      const proposed = (await host.api.invoke("memory.propose_draft", {
        target: context.target,
        draft: {
          candidates: [
            {
              kind: "episode",
              title: "Coffee with Sam",
              body: "Met Sam Rivera for coffee at the station cafe in Elmwood.",
              shelf: "LIF/GTH",
              occurredOn: "2026-12-27",
              tags: [],
              people: [{ name: "Sam Rivera" }],
              occasion: null,
              quote: said,
            },
          ],
        },
      })) as { queued: Array<{ id: string }> };
      const id = proposed.queued[0]!.id;

      const listed = await app.request("/host/review");
      expect((await listed.json()) as unknown).toMatchObject({
        proposals: [{ id, state: "pending", tool: "memory.remember" }],
      });
      expect(await host.silo.memory.count()).toBe(0);

      const confirmed = await app.request(`/host/review/${id}/confirm`, { method: "POST" });
      expect(confirmed.status).toBe(200);
      expect(await host.silo.memory.count()).toBe(1);

      // Decided once, so a second decision is a conflict rather than a write.
      const again = await app.request(`/host/review/${id}/confirm`, { method: "POST" });
      expect(again.status).toBe(409);
      expect(await host.silo.memory.count()).toBe(1);

      const missing = await app.request(`/host/review/nope/confirm`, { method: "POST" });
      expect(missing.status).toBe(404);

      const bad = await app.request(`/host/review/${id}/maybe`, { method: "POST" });
      expect(bad.status).toBe(400);
    } finally {
      await host.close();
    }
  });

  it("shows the audit log, the event feed and the config", async () => {
    const host = await throwawayHost();
    const app = createApp(host);
    try {
      await remember(host, { shelf: "LIF/HOM", body: BODY });

      const events = (await (await app.request("/host/events")).json()) as { events: Array<{ name: string }> };
      expect(events.events.map((event) => event.name)).toContain("memory.memory.written");

      const audit = (await (await app.request("/host/audit")).json()) as { entries: Array<{ tool: string }> };
      expect(audit.entries.map((entry) => entry.tool)).toContain("memory.remember");

      const config = (await (await app.request("/host/config")).json()) as { config: { incognito: boolean } };
      expect(config.config.incognito).toBe(false);

      const changed = await app.request("/host/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ coreTokenCap: 600 }),
      });
      expect(((await changed.json()) as { config: { coreTokenCap: number } }).config.coreTokenCap).toBe(600);

      const invalid = await app.request("/host/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ coreTokenCap: 5 }),
      });
      expect(invalid.status).toBe(400);
      expect(host.config().coreTokenCap).toBe(600);
    } finally {
      await host.close();
    }
  });
});
