import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RetireToolResult } from "../../../src/tools/write/retire.js";
import { testHost, type TestHost } from "../../test-host.js";
import { NOW, remember, versions } from "./helpers.js";

describe("memory.retire", () => {
  let host: TestHost;

  beforeEach(async () => {
    host = await testHost({ now: NOW });
  });
  afterEach(async () => {
    await host.close();
  });

  it("moves an active entry to the stacks, keeping its number and history", async () => {
    const first = await remember(host, { body: "Keeps a bike in the shed." });
    const result = await host.invoke<RetireToolResult>("memory.retire", { call: first.memory.call });

    expect(result.memory).toMatchObject({ call: first.memory.call, state: "retired" });
    expect(await host.db.memory.count()).toBe(1);
    const rows = await versions(host, first.memory.id);
    expect(rows.map((row) => row.operation)).toEqual(["create", "retire"]);
    expect(rows[0]?.content?.body).toBe("Keeps a bike in the shed.");
    expect(rows[1]?.content?.state).toBe("retired");
    expect(host.audit.at(-1)).toMatchObject({
      tool: "memory.retire",
      ids: { memoryIds: [first.memory.id], calls: [first.memory.call] },
    });
  });

  it("refuses an entry already retired, and a superseded one", async () => {
    const first = await remember(host, { body: "Keeps a bike in the shed." });
    await host.invoke("memory.retire", { call: first.memory.call });
    await expect(host.invoke("memory.retire", { call: first.memory.call })).rejects.toMatchObject({ code: "refused" });

    const other = await remember(host, { occurredOn: "2026-01-02", body: "Lives on Elm Street." });
    await host.invoke("memory.supersede", { call: other.memory.call, body: "Lives on Oak Street." });
    await expect(host.invoke("memory.retire", { call: other.memory.call })).rejects.toMatchObject({ code: "refused" });
  });

  it("refuses while incognito is on", async () => {
    const first = await remember(host, { body: "Keeps a bike in the shed." });
    host.setIncognito(true);
    await expect(host.invoke("memory.retire", { call: first.memory.call })).rejects.toMatchObject({ code: "refused" });
    expect((await host.db.memory.findUniqueOrThrow({ where: { id: first.memory.id } })).state).toBe("active");
  });
});
