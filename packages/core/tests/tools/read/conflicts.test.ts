import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ConflictsResult } from "../../../src/tools/read/conflicts.js";
import { testHost, type TestHost } from "../../test-host.js";
import { NOW, seed } from "./fixtures.js";

describe("memory.conflicts", () => {
  let host: TestHost;

  beforeEach(async () => {
    host = await testHost({ now: NOW });
  });
  afterEach(async () => {
    await host.close();
  });

  it("lists pairs joined by contradicts, and only those", async () => {
    const tea = await seed(host, { kind: "preference", shelf: "LIF/HOM", title: "Tea", body: "Prefers tea." });
    const coffee = await seed(host, { kind: "preference", shelf: "LIF/HOM", title: "Coffee", body: "Prefers coffee." });
    const more = await seed(host, { kind: "preference", shelf: "LIF/HOM", title: "Tea detail", body: "Green tea." });
    await host.db.memoryLink.create({ data: { fromId: coffee.id, toId: tea.id, relation: "contradicts" } });
    await host.db.memoryLink.create({ data: { fromId: more.id, toId: tea.id, relation: "elaborates" } });

    const result = await host.invoke<ConflictsResult>("memory.conflicts");
    expect(result.total).toBe(1);
    expect(result.pairs[0]).toMatchObject({
      from: { memoryId: coffee.id, call: coffee.callNumber, title: "Coffee", state: "active" },
      to: { memoryId: tea.id, call: tea.callNumber, title: "Tea", state: "active" },
    });

    const forMore = await host.invoke<ConflictsResult>("memory.conflicts", { call: more.callNumber });
    expect(forMore.pairs).toEqual([]);
    const forTea = await host.invoke<ConflictsResult>("memory.conflicts", { call: tea.callNumber });
    expect(forTea.pairs).toHaveLength(1);
  });

  it("is empty when nothing contradicts anything", async () => {
    await seed(host);
    expect(await host.invoke("memory.conflicts")).toEqual({ pairs: [], total: 0 });
  });
});
