import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { TouchToolResult } from "../../../src/tools/write/touch.js";
import { testHost, type TestHost } from "../../test-host.js";
import { NOW, remember, versions } from "./helpers.js";

describe("memory.touch", () => {
  let host: TestHost;

  beforeEach(async () => {
    host = await testHost({ now: NOW });
  });
  afterEach(async () => {
    await host.close();
  });

  it("moves lastConfirmedAt to now and writes no version", async () => {
    const first = await remember(host, { body: "Prefers oat milk in coffee." });
    const later = new Date("2027-03-01T09:00:00.000Z");
    const result = await host.invoke<TouchToolResult>("memory.touch", { call: first.memory.call }, { now: later });

    expect(result.previousConfirmedAt).toBe(NOW.toISOString());
    expect(result.memory.lastConfirmedAt).toBe(later.toISOString());
    expect(result.memory.call).toBe(first.memory.call);
    expect((await versions(host, first.memory.id)).map((row) => row.operation)).toEqual(["create"]);
    expect(host.audit.at(-1)).toMatchObject({ tool: "memory.touch", ids: { memoryIds: [first.memory.id] } });
  });

  it("takes an old number after a reshelve", async () => {
    const first = await remember(host, { body: "Prefers oat milk in coffee." });
    await host.invoke("memory.shelve", { action: "move", call: first.memory.call, shelf: "LIF/HOM" });
    const result = await host.invoke<TouchToolResult>("memory.touch", { call: first.memory.call });
    expect(result.memory.call).toBe("LIF/HOM/2026-12-27/001");
  });

  it("refuses a superseded entry, and an unknown number is not_found", async () => {
    const first = await remember(host, { occurredOn: "2026-01-02", body: "Lives on Elm Street." });
    await host.invoke("memory.supersede", { call: first.memory.call, body: "Lives on Oak Street." });
    await expect(host.invoke("memory.touch", { call: first.memory.call })).rejects.toMatchObject({ code: "refused" });
    await expect(host.invoke("memory.touch", { call: "LIF/GTH/2026-12-24/009" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("refuses while incognito is on", async () => {
    const first = await remember(host, { body: "Prefers oat milk in coffee." });
    host.setIncognito(true);
    await expect(host.invoke("memory.touch", { call: first.memory.call })).rejects.toMatchObject({ code: "refused" });
  });
});
