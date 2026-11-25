import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { reshelveMemory } from "../../../src/domain/catalogue/shelving.js";
import { retireMemory } from "../../../src/domain/memories.js";
import { RECALL_NOTICE } from "../../../src/domain/recall/frame.js";
import type { BrowseResult } from "../../../src/tools/read/browse.js";
import { auditStrings, testHost, type TestHost } from "../../test-host.js";
import { NOW, seed } from "./fixtures.js";

describe("memory.browse", () => {
  let host: TestHost;

  beforeEach(async () => {
    host = await testHost({ now: NOW, session: { id: "session-1" } });
  });
  afterEach(async () => {
    await host.close();
  });

  async function december() {
    await seed(host, { title: "Party prep", body: "Bought lights for the party.", occurredOn: "2026-12-20" });
    await seed(host, { title: "Christmas Eve", body: "Christmas Eve dinner with Jane Doe.", occurredOn: "2026-12-24", tags: ["christmas"] });
    await seed(host, { title: "Christmas lunch", body: "Lunch with John Doe.", occurredOn: "2026-12-24", tags: ["christmas"] });
    await seed(host, { title: "Boxing Day walk", body: "A walk with Sam Rivera.", occurredOn: "2026-12-26" });
    await seed(host, { title: "Rome", body: "Pizza in Rome.", shelf: "LIF/TRV", occurredOn: "2026-12-24", tags: ["vacation"] });
  }

  const calls = (result: BrowseResult) => result.items.map((item) => item.call);

  it("walks a shelf in call number order, ascending or descending, never ranked", async () => {
    await december();
    const asc = await host.invoke<BrowseResult>("memory.browse", { shelf: "LIF/GTH", order: "asc" });
    expect(asc.notice).toBe(RECALL_NOTICE);
    expect(calls(asc)).toEqual([
      "LIF/GTH/2026-12-20/001",
      "LIF/GTH/2026-12-24/001",
      "LIF/GTH/2026-12-24/002",
      "LIF/GTH/2026-12-26/001",
    ]);
    const desc = await host.invoke<BrowseResult>("memory.browse", { shelf: "LIF/GTH", order: "desc" });
    expect(calls(desc)).toEqual([...calls(asc)].reverse());
    expect(asc.items[0]).not.toHaveProperty("score");
  });

  it("takes a call number prefix or a wildcard query", async () => {
    await december();
    const month = await host.invoke<BrowseResult>("memory.browse", { prefix: "LIF/GTH/2026-12-24" });
    expect(calls(month)).toEqual(["LIF/GTH/2026-12-24/001", "LIF/GTH/2026-12-24/002"]);
    const day = await host.invoke<BrowseResult>("memory.browse", { prefix: "*/*/2026-12-24" });
    expect(calls(day)).toEqual(["LIF/GTH/2026-12-24/001", "LIF/GTH/2026-12-24/002", "LIF/TRV/2026-12-24/001"]);
    await expect(host.invoke("memory.browse", { prefix: "lif/gth" })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("filters by date range, inclusive, and by tags to include or exclude", async () => {
    await december();
    const range = await host.invoke<BrowseResult>("memory.browse", { from: "2026-12-21", to: "2026-12-24" });
    expect(calls(range)).toEqual(["LIF/GTH/2026-12-24/001", "LIF/GTH/2026-12-24/002", "LIF/TRV/2026-12-24/001"]);
    const tagged = await host.invoke<BrowseResult>("memory.browse", { tags: ["#Christmas"], order: "desc" });
    expect(calls(tagged)).toEqual(["LIF/GTH/2026-12-24/002", "LIF/GTH/2026-12-24/001"]);
    const without = await host.invoke<BrowseResult>("memory.browse", { excludeTags: ["christmas", "vacation"] });
    expect(calls(without)).toEqual(["LIF/GTH/2026-12-20/001", "LIF/GTH/2026-12-26/001"]);
  });

  it("shows what came just before and after one entry, on its shelf, old numbers included", async () => {
    await december();
    const around = await host.invoke<BrowseResult>("memory.browse", { around: "LIF/GTH/2026-12-24/001", span: 1 });
    expect(around.anchor).toBe("LIF/GTH/2026-12-24/001");
    expect(calls(around)).toEqual(["LIF/GTH/2026-12-20/001", "LIF/GTH/2026-12-24/001", "LIF/GTH/2026-12-24/002"]);
    expect(around.nextCursor).toBeNull();

    await reshelveMemory(host.db, "LIF/GTH/2026-12-26/001", { shelf: "LIF/HOM" }, { actor: "user" });
    const moved = await host.invoke<BrowseResult>("memory.browse", { around: "LIF/GTH/2026-12-26/001" });
    expect(moved.anchor).toBe("LIF/HOM/2026-12-26/001");
    expect(calls(moved)).toEqual(["LIF/HOM/2026-12-26/001"]);
  });

  it("pages with a cursor until the last page", async () => {
    await december();
    const first = await host.invoke<BrowseResult>("memory.browse", { shelf: "LIF/GTH", limit: 3 });
    expect(calls(first)).toHaveLength(3);
    expect(first.nextCursor).toBe("LIF/GTH/2026-12-24/002");
    const second = await host.invoke<BrowseResult>("memory.browse", { shelf: "LIF/GTH", limit: 3, cursor: first.nextCursor });
    expect(calls(second)).toEqual(["LIF/GTH/2026-12-26/001"]);
    expect(second.nextCursor).toBeNull();

    const back = await host.invoke<BrowseResult>("memory.browse", { shelf: "LIF/GTH", limit: 3, order: "desc" });
    const rest = await host.invoke<BrowseResult>("memory.browse", { shelf: "LIF/GTH", limit: 3, order: "desc", cursor: back.nextCursor });
    expect(calls(rest)).toEqual(["LIF/GTH/2026-12-20/001"]);
  });

  it("includes retired entries only on request", async () => {
    const memory = await seed(host);
    await retireMemory(host.db, { id: memory.id }, { actor: "user", at: NOW });
    expect((await host.invoke<BrowseResult>("memory.browse", { shelf: "LIF/GTH" })).items).toEqual([]);
    const all = await host.invoke<BrowseResult>("memory.browse", { shelf: "LIF/GTH", includeRetired: true });
    expect(all.items.map((item) => item.state)).toEqual(["retired"]);
  });

  it("answers an empty shelf with an empty page, and an unknown shelf with not_found", async () => {
    const empty = await host.invoke<BrowseResult>("memory.browse", { shelf: "REF/LNK" });
    expect(empty.items).toEqual([]);
    expect(empty.nextCursor).toBeNull();
    await expect(host.invoke("memory.browse", { shelf: "ZZZ/ZZZ" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("refuses a cursor with around", async () => {
    await expect(
      host.invoke("memory.browse", { around: "LIF/GTH/2026-12-24/001", cursor: "LIF/GTH/2026-12-24/001" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("audits ids and numbers only", async () => {
    await december();
    host.audit.length = 0;
    await host.invoke("memory.browse", { shelf: "LIF/GTH" });
    expect(host.audit[0]).toMatchObject({ tool: "memory.browse", kind: "read", detail: { itemsCount: 4 } });
    expect(host.audit[0]!.ids?.calls).toHaveLength(4);
    expect(auditStrings(host).some((text) => text.includes("Christmas"))).toBe(false);
  });
});
