import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { retireMemory } from "../../../src/domain/memories.js";
import type { SearchResult } from "../../../src/tools/read/search.js";
import { auditStrings, testHost, type TestHost } from "../../test-host.js";
import { NOW, seed } from "./fixtures.js";

describe("memory.search", () => {
  let host: TestHost;

  beforeEach(async () => {
    host = await testHost({ now: NOW });
  });
  afterEach(async () => {
    await host.close();
  });

  it("finds entries holding every word, the last as a prefix, best first, with no weighting or framing", async () => {
    await seed(host, { title: "Pizza night", body: "We ordered pizza from the corner place." });
    await seed(host, { title: "Rome", body: "Pizza in Rome, and gelato after.", shelf: "LIF/TRV", trust: "external", sources: [{ source: { kind: "page", label: "a page", trust: "external" }, quote: "pizza" }] });
    await seed(host, { title: "Salad", body: "Just a salad." });

    const result = await host.invoke<SearchResult>("memory.search", { query: "pizz" });
    expect(result.items.map((item) => item.title)).toEqual(["Pizza night", "Rome"]);
    expect(result).not.toHaveProperty("notice");
    expect(result).not.toHaveProperty("sufficient");
    expect(result.items[0]).not.toHaveProperty("score");
    expect(result.items[0]!.bm25).toEqual(expect.any(Number));

    const both = await host.invoke<SearchResult>("memory.search", { query: "pizza gelato" });
    expect(both.items.map((item) => item.title)).toEqual(["Rome"]);
  });

  it("returns an empty list rather than abstaining, and a query of only punctuation finds nothing", async () => {
    await seed(host);
    expect(await host.invoke("memory.search", { query: "kayak" })).toEqual({ items: [] });
    expect(await host.invoke("memory.search", { query: "\"*:" })).toEqual({ items: [] });
  });

  it("leaves retired entries out unless asked", async () => {
    const memory = await seed(host);
    await retireMemory(host.db, { id: memory.id }, { actor: "user", at: NOW });
    expect((await host.invoke<SearchResult>("memory.search", { query: "pizza" })).items).toEqual([]);
    expect((await host.invoke<SearchResult>("memory.search", { query: "pizza", includeRetired: true })).items).toHaveLength(1);
  });

  it("writes no RecallLog row and audits no query text", async () => {
    await seed(host);
    host.audit.length = 0;
    await host.invoke("memory.search", { query: "pizza secretword" });
    await host.invoke("memory.search", { query: "pizza" });
    expect(await host.db.recallLog.count()).toBe(0);
    expect(auditStrings(host).some((text) => text.includes("secretword") || text.includes("pizza"))).toBe(false);
  });
});
