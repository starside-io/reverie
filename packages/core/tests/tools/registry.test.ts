import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { DomainError } from "../../src/domain/errors.js";
import { surfaceFingerprint } from "../../src/fingerprint.js";
import {
  createRegistry,
  defineTool,
  fromMcpName,
  invokeTool,
  mcpName,
  registry,
  ToolError,
  type AnyTool,
  type ToolContext,
} from "../../src/tools/index.js";
import { testHost, type TestHost } from "../test-host.js";

describe("the registry", () => {
  let host: TestHost;

  beforeEach(async () => {
    host = await testHost();
  });
  afterEach(async () => {
    await host.close();
  });

  const probe = (kind: "read" | "write" | "needs-ok", handler: (ctx: ToolContext) => Promise<unknown>) =>
    createRegistry([
      defineTool<Record<string, unknown>, unknown>({
        name: "memory.probe",
        title: "Probe",
        kind,
        summary: "A test tool.",
        input: z.object({}).passthrough(),
        handler: (ctx) => handler(ctx),
        auditIds: () => ({
          memoryIds: ["2b1f0c4e-1111-4222-8333-944455556666", "a title with spaces"],
          calls: ["LIF/GTH/2026-12-24/001", "not a call"],
        }),
      }) as unknown as AnyTool,
    ]);

  it("maps a DomainError onto a ToolError with the same code and audits the refusal", async () => {
    const reg = probe("read", async () => {
      throw new DomainError("conflict", "Taken.", { why: "test" });
    });
    const error = await invokeTool(reg, host.ports, "memory.probe", {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ToolError);
    expect(error).toMatchObject({ code: "conflict", message: "Taken.", detail: { why: "test" } });
    expect(host.audit.at(-1)).toMatchObject({ tool: "memory.probe", detail: { refused: "conflict" } });
  });

  it("keeps only ids and call numbers in the audit ids", async () => {
    const reg = probe("read", async () => ({ count: 2, title: "Christmas at home" }));
    await invokeTool(reg, host.ports, "memory.probe", {});
    expect(host.audit.at(-1)).toEqual({
      tool: "memory.probe",
      kind: "read",
      at: expect.any(Date),
      ids: { memoryIds: ["2b1f0c4e-1111-4222-8333-944455556666"], calls: ["LIF/GTH/2026-12-24/001"] },
      detail: { count: 2 },
    });
  });

  it("emits queued events only after the handler returns, and drops them when it throws", async () => {
    let emittedDuringHandler = 0;
    const ok = probe("write", async (ctx) => {
      ctx.emit("memory.memory.written", { memoryId: "m1" });
      emittedDuringHandler = host.events.length;
      return {};
    });
    await invokeTool(ok, host.ports, "memory.probe", {});
    expect(emittedDuringHandler).toBe(0);
    expect(host.events).toEqual([{ name: "memory.memory.written", payload: { memoryId: "m1" } }]);

    const failing = probe("write", async (ctx) => {
      ctx.emit("memory.memory.written", { memoryId: "m2" });
      throw new ToolError("refused", "No.");
    });
    await expect(invokeTool(failing, host.ports, "memory.probe", {})).rejects.toMatchObject({ code: "refused" });
    expect(host.events).toHaveLength(1);
  });

  it("refuses write and needs-ok tools while incognito is on, before the handler runs", async () => {
    host.setIncognito(true);
    let ran = 0;
    for (const kind of ["write", "needs-ok"] as const) {
      const reg = probe(kind, async () => {
        ran += 1;
        return {};
      });
      await expect(invokeTool(reg, host.ports, "memory.probe", {})).rejects.toMatchObject({
        code: "refused",
        detail: { incognito: true },
      });
    }
    expect(ran).toBe(0);

    const read = probe("read", async (ctx) => ({ incognito: ctx.incognito }));
    await expect(invokeTool(read, host.ports, "memory.probe", {})).resolves.toEqual({ incognito: true });
  });

  it("hands the handler the session, the actor and a fixed now", async () => {
    const now = new Date("2026-12-27T10:00:00.000Z");
    const reg = probe("read", async (ctx) => ({ session: ctx.session, actor: ctx.actor, now: ctx.now }));
    const result = await invokeTool(reg, host.ports, "memory.probe", {}, {
      now,
      session: { id: "s1", folder: "/work/nightstash" },
    });
    expect(result).toEqual({
      session: { id: "s1", folder: "/work/nightstash", gitRemote: null, agent: null },
      actor: "user",
      now,
    });
  });

  it("refuses an unknown tool", async () => {
    await expect(host.invoke("memory.nothing")).rejects.toMatchObject({ code: "unknown_tool" });
  });

  it("passes a handler's ToolError through with its code, and audits the refusal", async () => {
    const reg = probe("read", async () => {
      throw new ToolError("not_implemented", "Not built.");
    });
    await expect(invokeTool(reg, host.ports, "memory.probe", {})).rejects.toMatchObject({
      code: "not_implemented",
    });
    expect(host.audit.at(-1)).toMatchObject({ tool: "memory.probe", detail: { refused: "not_implemented" } });
  });

  it("refuses a needs-ok tool called without the yes before its handler runs", async () => {
    await expect(host.invoke("memory.redact", {})).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("has no tool left that answers not_implemented for an ordinary call", async () => {
    await expect(host.invoke("memory.recall", { query: "christmas" })).resolves.toMatchObject({
      sufficient: false,
    });
  });

  it("maps names to MCP and back", () => {
    expect(mcpName("memory.recall")).toBe("memory_recall");
    expect(mcpName("memory.fs_view")).toBe("memory_fs_view");
    expect(fromMcpName(registry, "memory_fs_view")).toBe("memory.fs_view");
    expect(fromMcpName(registry, "memory_nothing")).toBeUndefined();
  });

  it("refuses two tools with one name", () => {
    const tool = registry.byName("memory.get") as AnyTool;
    expect(() => createRegistry([tool, tool])).toThrow(/Two tools/);
  });
});

describe("surfaceFingerprint", () => {
  it("is stable across calls and changes with the surface", () => {
    const first = surfaceFingerprint();
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    expect(surfaceFingerprint()).toBe(first);

    const smaller = createRegistry(registry.tools.filter((tool) => tool.name !== "memory.get"));
    expect(surfaceFingerprint(smaller)).not.toBe(first);
  });
});
