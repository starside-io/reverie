import { afterEach, describe, expect, it } from "vitest";

import { retireMemory } from "../../../src/domain/memories.js";
import type { StaleResult } from "../../../src/tools/read/stale.js";
import { testHost, type TestHost, type TestHostOptions } from "../../test-host.js";
import { NOW, seed } from "./fixtures.js";

describe("memory.stale", () => {
  let host: TestHost;

  async function open(options: TestHostOptions = {}) {
    host = await testHost({ now: NOW, ...options });
    return host;
  }
  afterEach(async () => {
    await host.close();
  });

  it("lists active entries not confirmed in staleAfterDays, oldest confirmation first", async () => {
    await open();
    const oldest = await seed(host, { title: "Oldest", body: "One.", lastConfirmedAt: "2025-01-01T00:00:00.000Z" });
    const old = await seed(host, { title: "Old", body: "Two.", lastConfirmedAt: "2026-05-01T00:00:00.000Z" });
    await seed(host, { title: "Fresh", body: "Three.", lastConfirmedAt: "2026-12-01T00:00:00.000Z" });
    const retired = await seed(host, { title: "Retired", body: "Four.", lastConfirmedAt: "2025-01-01T00:00:00.000Z" });
    await retireMemory(host.db, { id: retired.id }, { actor: "user", at: NOW });

    const result = await host.invoke<StaleResult>("memory.stale");
    expect(result.staleAfterDays).toBe(180);
    expect(result.items.map((item) => item.id)).toEqual([oldest.id, old.id]);
    expect(result.items[1]!.daysSinceConfirmed).toBe(240);
    expect(result.total).toBe(2);
  });

  it("follows the configured staleAfterDays and the limit", async () => {
    await open({ config: { staleAfterDays: 30 } });
    await seed(host, { title: "A", body: "One.", lastConfirmedAt: "2026-11-01T00:00:00.000Z" });
    await seed(host, { title: "B", body: "Two.", lastConfirmedAt: "2026-11-02T00:00:00.000Z" });
    const result = await host.invoke<StaleResult>("memory.stale", { limit: 1 });
    expect(result.items.map((item) => item.title)).toEqual(["A"]);
    expect(result.total).toBe(2);
  });
});
