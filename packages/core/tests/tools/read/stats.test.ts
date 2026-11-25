import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { retireMemory } from "../../../src/domain/memories.js";
import type { StatsResult } from "../../../src/tools/read/stats.js";
import { testHost, type TestHost } from "../../test-host.js";
import { external, NOW, seed } from "./fixtures.js";

describe("memory.stats", () => {
  let host: TestHost;

  beforeEach(async () => {
    host = await testHost({ now: NOW });
  });
  afterEach(async () => {
    await host.close();
  });

  it("has every key at zero for an empty library", async () => {
    const result = await host.invoke<StatsResult>("memory.stats");
    expect(result.total).toBe(0);
    expect(result.byState).toEqual({ active: 0, superseded: 0, retired: 0 });
    expect(Object.keys(result.byKind)).toEqual(["fact", "preference", "procedure", "episode", "reference"]);
    expect(result.bySection.LIF).toBe(0);
    expect(result.byShelf["DSK/RET"]).toBe(0);
  });

  it("counts by section, shelf, kind, trust, state and scope", async () => {
    await seed(host);
    await seed(host, { kind: "fact", shelf: "LIF/HOM", title: "Key", body: "The key.", trust: "external", sources: external("key") });
    const retired = await seed(host, { kind: "reference", shelf: "REF/LNK", title: "Link", body: "A link.", scope: "session", scopeRef: "s1" });
    await retireMemory(host.db, { id: retired.id }, { actor: "user", at: NOW });

    const result = await host.invoke<StatsResult>("memory.stats");
    expect(result.total).toBe(3);
    expect(result.byState).toEqual({ active: 2, superseded: 0, retired: 1 });
    expect(result.byKind).toMatchObject({ episode: 1, fact: 1, reference: 1, procedure: 0 });
    expect(result.byTrust).toMatchObject({ stated: 2, external: 1 });
    expect(result.byScope).toMatchObject({ global: 2, session: 1 });
    expect(result.bySection).toMatchObject({ LIF: 2, REF: 1, WRK: 0 });
    expect(result.byShelf).toMatchObject({ "LIF/GTH": 1, "LIF/HOM": 1, "REF/LNK": 1 });
  });
});
