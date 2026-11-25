import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ExplainResult } from "../../../src/tools/read/explain.js";
import type { RecallResult } from "../../../src/tools/read/recall.js";
import { auditStrings, testHost, type TestHost } from "../../test-host.js";
import { NOW, seed } from "./fixtures.js";

type Sufficient = Extract<RecallResult, { sufficient: true }>;

describe("memory.explain", () => {
  let host: TestHost;

  beforeEach(async () => {
    host = await testHost({ now: NOW, session: { id: "session-1" } });
  });
  afterEach(async () => {
    await host.close();
  });

  it("lists the recalls that returned a memory, newest first, with rank, score and the weights", async () => {
    const pizza = await seed(host);
    const lunch = await seed(host, { title: "Lunch", body: "Pizza for lunch with John Doe.", importance: 5 });
    const first = await host.invoke<Sufficient>("memory.recall", { query: "pizza" });
    const second = await host.invoke<Sufficient>("memory.recall", { query: "pizza lunch" }, {
      now: new Date("2026-12-28T10:00:00.000Z"),
    });
    await host.invoke("memory.recall", { query: "nothing like it" });

    const result = await host.invoke<ExplainResult>("memory.explain", { call: pizza.callNumber });
    expect(result.call).toBe(pizza.callNumber);
    expect(result.recalls.map((recall) => recall.recallId)).toEqual([second.recallId, first.recallId]);
    const inFirst = first.items.findIndex((item) => item.id === pizza.id);
    expect(result.recalls[1]!.match).toEqual({ rank: inFirst + 1, score: expect.any(Number) });
    expect(result.recalls[1]!.match!.score).toBeCloseTo(first.items[inFirst]!.score, 2);
    expect(result.recalls[0]!.items.map((item) => item.memoryId)).toContain(lunch.id);
    expect(result.weights).toMatchObject({
      kind: "episode",
      importance: 3,
      importanceFactor: 0.9,
      trust: "stated",
      trustWeight: 1,
      halfLifeDays: 90,
    });
    expect(result.weights!.recency).toBeCloseTo(1, 5);
  });

  it("explains one recall by id, everything it returned, a forgotten memory as a null number", async () => {
    const pizza = await seed(host);
    const recall = await host.invoke<Sufficient>("memory.recall", { query: "pizza" });
    await host.invoke("memory.forget", { call: pizza.callNumber, confirmedByUser: true });

    const result = await host.invoke<ExplainResult>("memory.explain", { recallId: recall.recallId });
    expect(result.weights).toBeNull();
    expect(result.recalls).toHaveLength(1);
    expect(result.recalls[0]).toMatchObject({ scope: "session", scopeRef: "session-1", budget: 1200, match: null });
    expect(result.recalls[0]!.items).toEqual([{ rank: 1, memoryId: pizza.id, call: null, score: expect.any(Number) }]);
  });

  it("answers an empty list for a memory never recalled, and not_found for an unknown recall", async () => {
    const pizza = await seed(host);
    const result = await host.invoke<ExplainResult>("memory.explain", { call: pizza.callNumber });
    expect(result.recalls).toEqual([]);
    await expect(host.invoke("memory.explain", { recallId: "no-such-recall" })).rejects.toMatchObject({ code: "not_found" });
    await expect(host.invoke("memory.explain", {})).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("carries no query text, in the answer or the audit", async () => {
    const pizza = await seed(host);
    await host.invoke("memory.recall", { query: "pizza secretword" });
    const result = await host.invoke<ExplainResult>("memory.explain", { call: pizza.callNumber });
    expect(JSON.stringify(result)).not.toContain("secretword");
    expect(auditStrings(host).some((text) => text.includes("secretword"))).toBe(false);
  });
});
