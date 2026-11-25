import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import type { SessionInfo } from "@reverie/core";

import type { MiniHost } from "../src/host.js";
import { createMcpServer, mcpName } from "../src/mcp.js";
import { sessionFromEnvironment } from "../src/session.js";
import { auditText, throwawayHost } from "./harness.js";

/**
 * The stdio server's protocol side, over an in-memory pair so each test gets
 * its own host. Everything goes over the protocol, through the same registry
 * /rpc uses, so the gates hold on this side too. Lifted from Fellowship's
 * mcp.test.ts. tests/e2e-stdio.test.ts drives the real process.
 */

const SESSION: SessionInfo = { id: "session-jane-1", folder: "/work/elmwood", gitRemote: null, agent: null };

async function connect(host: MiniHost, session: SessionInfo = SESSION) {
  const server = createMcpServer(host, { session });
  const client = new Client({ name: "test-assistant", version: "0.0.1" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();

  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return { client, close: async () => void (await Promise.all([client.close(), server.close()])) };
}

/** The text payload of a tool result, parsed back. */
function payloadOf<T>(result: unknown): T {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  const text = content.find((entry) => entry.type === "text")?.text ?? "null";
  return JSON.parse(text) as T;
}

const manifest = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "module.json"), "utf8"),
) as { tools: Record<string, string[]> };

describe("the stdio server", () => {
  it("advertises exactly the 41 tools of module.json, with dots mapped to underscores", async () => {
    const host = await throwawayHost();
    const { client, close } = await connect(host);
    try {
      const listed = await client.listTools();
      expect(listed.tools).toHaveLength(41);

      const names = listed.tools.map((tool) => tool.name).sort();
      const declared = Object.values(manifest.tools).flat().map(mcpName).sort();
      expect(names).toEqual(declared);
      expect(names.some((name) => name.includes("."))).toBe(false);
      expect(mcpName("memory.fs_view")).toBe("memory_fs_view");

      // Every input schema is one object at the top, as clients and model APIs require.
      for (const tool of listed.tools) {
        expect(tool.inputSchema.type, tool.name).toBe("object");
        expect(tool.inputSchema, tool.name).not.toHaveProperty("anyOf");
        expect(tool.inputSchema, tool.name).not.toHaveProperty("oneOf");
      }

      const recall = listed.tools.find((tool) => tool.name === "memory_recall");
      expect(Object.keys(recall?.inputSchema.properties ?? {})).toContain("query");
      expect(recall?.annotations?.readOnlyHint).toBe(true);

      // A union on action is published flat, with every action listed.
      const shelve = listed.tools.find((tool) => tool.name === "memory_shelve");
      const action = (shelve?.inputSchema.properties as Record<string, { enum?: string[] }>)["action"];
      expect(action?.enum).toContain("move");
      expect(shelve?.inputSchema.required).toContain("action");

      const forget = listed.tools.find((tool) => tool.name === "memory_forget");
      expect(forget?.annotations?.destructiveHint).toBe(true);
      expect(forget?.description).toContain("confirmedByUser");
    } finally {
      await close();
      await host.close();
    }
  });

  it("remembers, browses and recalls over the protocol", async () => {
    const host = await throwawayHost();
    const { client, close } = await connect(host);
    try {
      const made = payloadOf<{ memory: { call: string } }>(
        await client.callTool({
          name: "memory_remember",
          arguments: { kind: "fact", shelf: "LIF/HOM", body: "Prefers oat milk in coffee." },
        }),
      );

      const browsed = payloadOf<{ items: Array<{ call: string }> }>(
        await client.callTool({ name: "memory_browse", arguments: { shelf: "LIF/HOM" } }),
      );
      expect(browsed.items.map((item) => item.call)).toEqual([made.memory.call]);

      const recalled = payloadOf<{ sufficient: boolean; items: Array<{ call: string }> }>(
        await client.callTool({ name: "memory_recall", arguments: { query: "oat milk coffee" } }),
      );
      expect(recalled.sufficient).toBe(true);
      expect(recalled.items[0]!.call).toBe(made.memory.call);
    } finally {
      await close();
      await host.close();
    }
  });

  it("passes the session along: a session memory is scoped to the server's session id", async () => {
    const host = await throwawayHost();
    const { client, close } = await connect(host);
    try {
      const made = payloadOf<{ memory: { id: string } }>(
        await client.callTool({
          name: "memory_remember",
          arguments: { kind: "fact", shelf: "LIF/HOM", scope: "session", body: "Working through the kettle notes." },
        }),
      );
      const row = await host.silo.memory.findUniqueOrThrow({ where: { id: made.memory.id } });
      expect(row.scope).toBe("session");
      expect(row.scopeRef).toBe("session-jane-1");
    } finally {
      await close();
      await host.close();
    }
  });

  it("keeps the gates: a needs-ok tool refuses over the protocol without the owner's yes", async () => {
    const host = await throwawayHost();
    const { client, close } = await connect(host);
    try {
      const made = payloadOf<{ memory: { call: string } }>(
        await client.callTool({
          name: "memory_remember",
          arguments: { kind: "fact", shelf: "LIF/HOM", body: "Lent the ladder to the neighbours on Elm Street." },
        }),
      );

      const refused = await client.callTool({ name: "memory_forget", arguments: { call: made.memory.call } });
      expect(refused.isError).toBe(true);
      expect(JSON.stringify(refused.content)).toContain("invalid_input");
      expect(await host.silo.memory.count()).toBe(1);

      const secret = await client.callTool({
        name: "memory_remember",
        arguments: { kind: "fact", body: "The deploy key is ghp_abcdefghijklmnopqrstuvwxyz0123456789" },
      });
      expect(secret.isError).toBe(true);
      expect(await host.silo.memory.count()).toBe(1);

      const unknown = await client.callTool({ name: "memory_nope", arguments: {} });
      expect(unknown.isError).toBe(true);
    } finally {
      await close();
      await host.close();
    }
  });

  it("writes nothing while incognito is on, and still answers reads", async () => {
    const host = await throwawayHost();
    await host.ports.settings.set({ incognito: true });
    const { client, close } = await connect(host);
    try {
      const refused = await client.callTool({
        name: "memory_remember",
        arguments: { kind: "fact", shelf: "LIF/HOM", body: "Prefers oat milk in coffee." },
      });
      expect(refused.isError).toBe(true);
      expect(JSON.stringify(refused.content)).toContain("Incognito");
      expect(await host.silo.memory.count()).toBe(0);

      const read = await client.callTool({ name: "memory_shelves", arguments: {} });
      expect(read.isError).toBeFalsy();
    } finally {
      await close();
      await host.close();
    }
  });

  it("audits what an assistant did, in the host's own file, with no memory text", async () => {
    const host = await throwawayHost();
    const { client, close } = await connect(host);
    try {
      await client.callTool({
        name: "memory_remember",
        arguments: { kind: "fact", shelf: "LIF/HOM", body: "The bike pump lives in the hall cupboard." },
      });
      await client.callTool({ name: "memory_recall", arguments: { query: "bike pump" } });

      const tools = host.store.listAudit().map((entry) => entry.tool);
      expect(tools).toEqual(["memory.recall", "memory.remember"]);
      expect(auditText(host)).not.toMatch(/bike|pump|cupboard/);
    } finally {
      await close();
      await host.close();
    }
  });
});

describe("the session from the environment", () => {
  it("takes the folder from the working directory, and the id and agent from REVERIE_ variables", () => {
    const session = sessionFromEnvironment(
      { REVERIE_SESSION_ID: "session-jane-2", REVERIE_AGENT: "reviewer" },
      "/nonexistent/elmwood",
    );
    expect(session).toEqual({
      id: "session-jane-2",
      folder: "/nonexistent/elmwood",
      gitRemote: null,
      agent: "reviewer",
    });
  });

  it("makes up a fresh session id per server when none is given, and names no agent", () => {
    const a = sessionFromEnvironment({}, "/nonexistent/elmwood");
    const b = sessionFromEnvironment({}, "/nonexistent/elmwood");
    expect(a.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.id).not.toBe(b.id);
    expect(a.agent).toBeNull();
  });
});
