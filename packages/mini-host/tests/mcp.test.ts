import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";

import type { SessionInfo } from "@reverie/core";

import type { MiniHost } from "../src/host.js";
import { HOST_TOOL_NAMES, createMcpServer, mcpName } from "../src/mcp.js";
import { sessionFromEnvironment } from "../src/session.js";
import { REVERIE_VERSION } from "../src/version.js";
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
  it("advertises exactly the 41 tools of module.json, with dots mapped to underscores, plus the 3 host tools", async () => {
    const host = await throwawayHost();
    const { client, close } = await connect(host);
    try {
      const listed = await client.listTools();
      // 41 module tools from module.json, and the host's own app_* tools,
      // which belong to this server and are in no manifest.
      expect(listed.tools).toHaveLength(41 + HOST_TOOL_NAMES.length);
      expect(HOST_TOOL_NAMES).toEqual(["app_status", "app_install", "app_open"]);

      const all = listed.tools.map((tool) => tool.name);
      const names = all.filter((name) => !(HOST_TOOL_NAMES as readonly string[]).includes(name)).sort();
      const declared = Object.values(manifest.tools).flat().map(mcpName).sort();
      expect(declared).toHaveLength(41);
      expect(names).toEqual(declared);
      expect(all.filter((name) => (HOST_TOOL_NAMES as readonly string[]).includes(name)).sort()).toEqual(
        [...HOST_TOOL_NAMES].sort(),
      );
      expect(declared.some((name) => name.startsWith("app_"))).toBe(false);
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

  it("takes Claude Code's session id when REVERIE_SESSION_ID is not set, and REVERIE_SESSION_ID over it", () => {
    const claude = "7d3c1f2e-5a4b-4c6d-8e9f-0a1b2c3d4e5f";
    expect(sessionFromEnvironment({ CLAUDE_CODE_SESSION_ID: claude }, "/nonexistent/elmwood").id).toBe(claude);
    expect(
      sessionFromEnvironment({ CLAUDE_CODE_SESSION_ID: claude, REVERIE_SESSION_ID: "session-sam-1" }, "/nonexistent/elmwood")
        .id,
    ).toBe("session-sam-1");
  });

  it("makes up a fresh session id per server when none is given, and names no agent", () => {
    const a = sessionFromEnvironment({}, "/nonexistent/elmwood");
    const b = sessionFromEnvironment({}, "/nonexistent/elmwood");
    expect(a.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.id).not.toBe(b.id);
    expect(a.agent).toBeNull();
  });
});

describe("the host's app tools", () => {
  /** A server whose app tools see a throwaway app folder, a stand in GitHub and no real `open`. */
  async function connectWithApp(host: MiniHost, app: NonNullable<Parameters<typeof createMcpServer>[1]>["app"]) {
    const server = createMcpServer(host, { session: SESSION, ...(app ? { app } : {}) });
    const client = new Client({ name: "test-assistant", version: "0.0.1" });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    return { client, close: async () => void (await Promise.all([client.close(), server.close()])) };
  }

  function appFolder(): NodeJS.ProcessEnv {
    return { REVERIE_APP_DIR: mkdtempSync(join(tmpdir(), "reverie-apps-")) };
  }

  function bundle(at: string, version: string) {
    mkdirSync(join(at, "Contents"), { recursive: true });
    writeFileSync(
      join(at, "Contents", "Info.plist"),
      `<plist><dict><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`,
    );
  }

  it("are listed with their schemas, and the instructions name them", async () => {
    const host = await throwawayHost();
    const { client, close } = await connectWithApp(host, { env: appFolder() });
    try {
      const listed = await client.listTools();
      const install = listed.tools.find((tool) => tool.name === "app_install");
      expect(install?.inputSchema.required).toEqual(["confirmedByUser"]);
      expect(install?.annotations?.openWorldHint).toBe(true);
      expect(listed.tools.find((tool) => tool.name === "app_status")?.annotations?.readOnlyHint).toBe(true);
      expect(client.getInstructions()).toContain("app_open");
      expect(client.getInstructions()).toContain("app_install");
      expect(client.getServerVersion()).toMatchObject({ name: "reverie", version: REVERIE_VERSION });
    } finally {
      await close();
      await host.close();
    }
  });

  it("app_status reads the app folder and reaches no network", async () => {
    const host = await throwawayHost();
    const env = appFolder();
    bundle(join(env["REVERIE_APP_DIR"]!, "Reverie.app"), "0.0.0-older");
    const fetch = vi.fn() as unknown as typeof globalThis.fetch;
    const { client, close } = await connectWithApp(host, { env, fetch, supported: true });
    try {
      const status = payloadOf<Record<string, unknown>>(await client.callTool({ name: "app_status", arguments: {} }));
      expect(status).toMatchObject({
        supported: true,
        version: "0.0.0-older",
        available: REVERIE_VERSION,
        behind: true,
        path: join(env["REVERIE_APP_DIR"]!, "Reverie.app"),
      });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      await close();
      await host.close();
    }
  });

  it("app_install refuses without confirmedByUser, and downloads nothing", async () => {
    const host = await throwawayHost();
    const fetch = vi.fn() as unknown as typeof globalThis.fetch;
    const { client, close } = await connectWithApp(host, { env: appFolder(), fetch, supported: true });
    try {
      for (const args of [{}, { confirmedByUser: false }, { confirmedByUser: "yes" }]) {
        const result = (await client.callTool({ name: "app_install", arguments: args })) as { isError?: boolean };
        expect(result.isError).toBe(true);
        expect(payloadOf<{ message: string }>(result).message).toMatch(/^refused/);
      }
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      await close();
      await host.close();
    }
  });

  it("app_install with the owner's yes asks for this server's own release", async () => {
    const host = await throwawayHost();
    const fetch = vi.fn(async () => new Response("{}", { status: 404 })) as unknown as typeof globalThis.fetch &
      ReturnType<typeof vi.fn>;
    const { client, close } = await connectWithApp(host, { env: appFolder(), fetch, supported: true });
    try {
      const result = await client.callTool({ name: "app_install", arguments: { confirmedByUser: true } });
      expect(payloadOf<{ ok: boolean; message: string }>(result)).toMatchObject({ ok: false });
      expect(String(fetch.mock.calls[0]![0])).toBe(
        `https://api.github.com/repos/starside-io/reverie/releases/tags/v${REVERIE_VERSION}`,
      );
    } finally {
      await close();
      await host.close();
    }
  });

  it("app_open opens an installed app, says when there is none, and writes no audit line", async () => {
    const host = await throwawayHost();
    const env = appFolder();
    const open = vi.fn(async () => undefined);
    const { client, close } = await connectWithApp(host, { env, open, supported: true });
    try {
      const missing = payloadOf<{ opened: boolean; message: string }>(await client.callTool({ name: "app_open", arguments: {} }));
      expect(missing.opened).toBe(false);
      expect(missing.message).toContain("app_install");
      expect(open).not.toHaveBeenCalled();

      bundle(join(env["REVERIE_APP_DIR"]!, "Reverie.app"), REVERIE_VERSION);
      const opened = payloadOf<{ opened: boolean }>(await client.callTool({ name: "app_open", arguments: {} }));
      expect(opened.opened).toBe(true);
      expect(open).toHaveBeenCalledTimes(1);
      expect(host.store.listAudit()).toEqual([]);
    } finally {
      await close();
      await host.close();
    }
  });

  it("app_open on a machine the app is not built for points at the browser", async () => {
    const host = await throwawayHost();
    const open = vi.fn(async () => undefined);
    const { client, close } = await connectWithApp(host, { env: appFolder(), open, supported: false });
    try {
      const answer = payloadOf<{ opened: boolean; message: string }>(await client.callTool({ name: "app_open", arguments: {} }));
      expect(answer.opened).toBe(false);
      expect(answer.message).toContain("reverie serve");
      expect(open).not.toHaveBeenCalled();
    } finally {
      await close();
      await host.close();
    }
  });
});
