import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { retireMemory } from "../../../src/domain/memories.js";
import type { ShelvesResult } from "../../../src/tools/read/shelves.js";
import { testHost, type TestHost } from "../../test-host.js";
import { NOW, seed } from "./fixtures.js";

describe("memory.shelves", () => {
  let host: TestHost;

  beforeEach(async () => {
    host = await testHost({ now: NOW });
  });
  afterEach(async () => {
    await host.close();
  });

  it("lists the starting library in order, with codes, names and descriptions", async () => {
    const result = await host.invoke<ShelvesResult>("memory.shelves");
    expect(result.sections.map((section) => section.code)).toEqual(["WRK", "LIF", "CRF", "REF", "DSK"]);
    const life = result.sections[1]!;
    expect(life.shelves.map((shelf) => shelf.path)).toEqual(["LIF/GTH", "LIF/TRV", "LIF/HOM", "LIF/HLT"]);
    expect(life.shelves[0]).toMatchObject({ code: "GTH", name: "Gatherings", count: 0, total: 0 });
    expect(life.shelves[0]!.description.length).toBeGreaterThan(0);
  });

  it("counts active entries and every entry", async () => {
    await seed(host);
    const retired = await seed(host, { title: "Second", body: "Another gathering." });
    await retireMemory(host.db, { id: retired.id }, { actor: "user", at: NOW });
    const result = await host.invoke<ShelvesResult>("memory.shelves");
    const life = result.sections.find((section) => section.code === "LIF")!;
    expect(life.shelves[0]).toMatchObject({ count: 1, total: 2 });
    expect(life).toMatchObject({ count: 1, total: 2 });
  });
});
