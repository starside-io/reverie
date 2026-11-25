import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { GetResult } from "../../../src/tools/read/get.js";
import type { ShelveToolResult } from "../../../src/tools/write/shelve.js";
import { testHost, type TestHost } from "../../test-host.js";
import { christmas, NOW, remember, versions } from "./helpers.js";

describe("memory.shelve", () => {
  let host: TestHost;

  beforeEach(async () => {
    host = await testHost({ now: NOW });
  });
  afterEach(async () => {
    await host.close();
  });

  const shelve = (input: Record<string, unknown>) => host.invoke<ShelveToolResult>("memory.shelve", input);

  it("moves a memory: new number, the old one still resolves, one shelved event", async () => {
    const first = await remember(host, { body: "Prefers oat milk in coffee." });
    host.events.length = 0;
    const result = await shelve({ action: "move", call: first.memory.call, shelf: "LIF/HOM" });

    expect(result).toMatchObject({ action: "move", from: "DSK/RET/2026-12-27/001", to: "LIF/HOM/2026-12-27/001" });
    const got = await host.invoke<GetResult>("memory.get", { call: "DSK/RET/2026-12-27/001" });
    expect(got.moved).toBe(true);
    expect(got.memory.call).toBe("LIF/HOM/2026-12-27/001");
    expect(got.memory.aliases).toEqual(["DSK/RET/2026-12-27/001"]);

    expect(host.events).toEqual([
      {
        name: "memory.memory.shelved",
        payload: { memoryId: first.memory.id, from: "DSK/RET/2026-12-27/001", to: "LIF/HOM/2026-12-27/001", via: "move" },
      },
    ]);
    const rows = await versions(host, first.memory.id);
    expect(rows.map((row) => row.operation)).toEqual(["create", "shelve"]);
    expect(rows[0]?.content?.callNumber).toBe("DSK/RET/2026-12-27/001");
  });

  it("moves to another day, and never reissues the number it left", async () => {
    const first = await christmas(host);
    await shelve({ action: "move", call: first.memory.call, occurredOn: "2026-12-25" });
    const next = await christmas(host, { title: "Boxing day walk", body: "Walked the dog by the river with John Doe." });
    expect(next.memory.call).toBe("LIF/GTH/2026-12-24/002");
  });

  it("refuses a move to where it already is, and a move with no target", async () => {
    const first = await christmas(host);
    await expect(shelve({ action: "move", call: first.memory.call, shelf: "LIF/GTH" })).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(shelve({ action: "move", call: first.memory.call })).rejects.toMatchObject({ code: "invalid_input" });
    expect(host.events.filter((event) => event.name === "memory.memory.shelved")).toEqual([]);
  });

  it("reorders seq within a shelf and day, aliasing every number that moved", async () => {
    const a = await christmas(host, { title: "Oven died", body: "The oven died mid afternoon." });
    const b = await christmas(host, { title: "Pizza", body: "We ordered pizza from the corner place." });
    const c = await christmas(host, { title: "Playlist", body: "Jane Doe and Sam Rivera argued about the playlist." });
    host.events.length = 0;

    const result = await shelve({
      action: "reorder",
      shelf: "LIF/GTH",
      occurredOn: "2026-12-24",
      order: [c.memory.call, a.memory.call, b.memory.call],
    });
    expect(result.action).toBe("reorder");
    if (result.action !== "reorder") return;
    expect(result.moved).toHaveLength(3);

    const now = await host.db.memory.findMany({ orderBy: { callNumber: "asc" }, select: { id: true } });
    expect(now.map((row) => row.id)).toEqual([c.memory.id, a.memory.id, b.memory.id]);
    expect(host.events.map((event) => event.name)).toEqual([
      "memory.memory.shelved",
      "memory.memory.shelved",
      "memory.memory.shelved",
    ]);
    // A number that is live again resolves to its live holder.
    const got = await host.invoke<GetResult>("memory.get", { call: "LIF/GTH/2026-12-24/001" });
    expect(got.memory.id).toBe(c.memory.id);
    expect((await versions(host, a.memory.id)).map((row) => row.operation)).toEqual(["create", "shelve"]);
  });

  it("refuses a reorder that does not name every entry of the day once", async () => {
    const a = await christmas(host, { title: "Oven died", body: "The oven died mid afternoon." });
    await christmas(host, { title: "Pizza", body: "We ordered pizza from the corner place." });
    await expect(
      shelve({ action: "reorder", shelf: "LIF/GTH", occurredOn: "2026-12-24", order: [a.memory.call] }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("refuses while incognito is on", async () => {
    const first = await remember(host, { body: "Prefers oat milk in coffee." });
    host.setIncognito(true);
    await expect(shelve({ action: "move", call: first.memory.call, shelf: "LIF/HOM" })).rejects.toMatchObject({
      code: "refused",
    });
  });
});
