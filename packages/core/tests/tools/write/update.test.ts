import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { UpdateToolResult } from "../../../src/tools/write/update.js";
import { auditStrings, testHost, type TestHost } from "../../test-host.js";
import { ftsHits } from "../../domain/library.js";
import { christmas, NOW, remember, versions } from "./helpers.js";

describe("memory.update", () => {
  let host: TestHost;

  beforeEach(async () => {
    host = await testHost({ now: NOW, session: { id: "session-1" } });
  });
  afterEach(async () => {
    await host.close();
  });

  const update = (input: Record<string, unknown>) => host.invoke<UpdateToolResult>("memory.update", input);

  it("writes a new version with the same call number, never in place", async () => {
    const first = await christmas(host);
    const result = await update({
      call: first.memory.call,
      body: "Hosted Christmas. The oven died, so we ordered pizza from the corner place. #hosting",
    });

    expect(result.changed).toBe(true);
    expect(result.memory.call).toBe(first.memory.call);
    expect(result.memory.id).toBe(first.memory.id);
    expect(result.memory.tags).toContain("hosting");
    expect(await host.db.memory.count()).toBe(1);

    const rows = await versions(host, first.memory.id);
    expect(rows.map((row) => row.operation)).toEqual(["create", "update"]);
    expect(rows[0]?.content?.body).toBe(first.memory.body);
    expect(rows[1]?.content?.body).toContain("corner place");
    expect(await ftsHits(host.db, "corner")).toHaveLength(1);
  });

  it("writes nothing when the input matches what is stored", async () => {
    const first = await christmas(host);
    const result = await update({ call: first.memory.call, title: "Christmas at home" });
    expect(result.changed).toBe(false);
    expect(await versions(host, first.memory.id)).toHaveLength(1);
    expect(host.events.filter((event) => event.name === "memory.memory.written")).toHaveLength(1);
  });

  it("runs discipline on the new content", async () => {
    const first = await remember(host, { body: "Keeps the router in the hall cupboard." });
    await expect(update({ call: first.memory.call, body: "The router password: hunter22, in the hall." })).rejects.toMatchObject({
      code: "refused",
      detail: { findings: expect.arrayContaining([expect.objectContaining({ check: "secret" })]) },
    });
    await expect(update({ call: first.memory.call, body: "Moved the router yesterday." })).rejects.toMatchObject({
      code: "refused",
      detail: { findings: expect.arrayContaining([expect.objectContaining({ check: "relativeDate" })]) },
    });
    await expect(update({ call: first.memory.call, why: "Doctor said to keep it away from the bed." })).rejects.toMatchObject({
      code: "refused",
    });
    expect(await versions(host, first.memory.id)).toHaveLength(1);
    const stored = await host.db.memory.findUniqueOrThrow({ where: { id: first.memory.id } });
    expect(stored.body).toBe("Keeps the router in the hall cupboard.");
  });

  it("cannot turn a memory into a procedure, nor change a procedure", async () => {
    const first = await remember(host, { body: "Runs the tests before a commit." });
    await expect(update({ call: first.memory.call, kind: "procedure", body: "Always run the tests." })).rejects.toMatchObject({
      code: "refused",
      message: expect.stringContaining("promote_procedure"),
    });
    await expect(update({ call: first.memory.call, kind: "preference", body: "Likes tests." })).rejects.toMatchObject({
      code: "refused",
      message: expect.stringContaining("supersede"),
    });

    const row = await host.db.memory.findUniqueOrThrow({ where: { id: first.memory.id } });
    await host.db.memory.update({ where: { id: row.id }, data: { kind: "procedure" } });
    await expect(update({ call: first.memory.call, body: "Never run the tests." })).rejects.toMatchObject({ code: "refused" });
  });

  it("refuses a superseded entry and names its replacement", async () => {
    const first = await remember(host, { shelf: "LIF/HOM", occurredOn: "2026-01-10", body: "Lives on Elm Street." });
    const next = await host.invoke<{ replacement: { call: string } }>("memory.supersede", {
      call: first.memory.call,
      body: "Lives on Oak Street.",
    });
    await expect(update({ call: first.memory.call, body: "Lives on Elm Road." })).rejects.toMatchObject({
      code: "refused",
      detail: { supersededBy: next.replacement.call },
    });
  });

  it("resolves an old number after a reshelve", async () => {
    const first = await remember(host, { body: "Prefers oat milk in coffee." });
    await host.invoke("memory.shelve", { action: "move", call: first.memory.call, shelf: "LIF/HOM" });
    const result = await update({ call: first.memory.call, importance: 5 });
    expect(result.memory.call).toBe("LIF/HOM/2026-12-27/001");
    expect(result.memory.importance).toBe(5);
  });

  it("emits memory.memory.written with no text and audits ids only", async () => {
    const first = await remember(host, { body: "Prefers oat milk in coffee." });
    host.events.length = 0;
    await update({ call: first.memory.call, body: "Prefers oat milk in coffee, never soy." });
    expect(host.events).toEqual([
      {
        name: "memory.memory.written",
        payload: {
          memoryId: first.memory.id,
          call: first.memory.call,
          door: "direct",
          operation: "update",
          kind: "fact",
          trust: "stated",
        },
      },
    ]);
    expect(host.audit.at(-1)).toMatchObject({
      tool: "memory.update",
      ids: { memoryIds: [first.memory.id], calls: [first.memory.call] },
      detail: { changed: true },
    });
    expect(auditStrings(host).some((text) => text.includes("soy"))).toBe(false);
  });

  it("refuses while incognito is on", async () => {
    const first = await remember(host, { body: "Prefers oat milk in coffee." });
    host.setIncognito(true);
    await expect(update({ call: first.memory.call, importance: 4 })).rejects.toMatchObject({
      code: "refused",
      detail: { incognito: true },
    });
    expect(await versions(host, first.memory.id)).toHaveLength(1);
  });

  it("refuses an empty patch", async () => {
    const first = await remember(host, { body: "Prefers oat milk in coffee." });
    await expect(update({ call: first.memory.call })).rejects.toMatchObject({ code: "invalid_input" });
  });
});
