import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { TagsResult } from "../../../src/tools/read/tags.js";
import { testHost, type TestHost } from "../../test-host.js";
import { NOW, seed } from "./fixtures.js";

describe("memory.tags", () => {
  let host: TestHost;

  beforeEach(async () => {
    host = await testHost({ now: NOW });
  });
  afterEach(async () => {
    await host.close();
  });

  it("is empty for a new library", async () => {
    expect(await host.invoke("memory.tags")).toEqual({ tags: [] });
  });

  it("lists one vocabulary with counts, most used first", async () => {
    await seed(host, { tags: ["#NightStash", "work"] });
    await seed(host, { title: "Two", body: "More about #nightstash pricing." });
    await seed(host, { title: "Three", body: "Holiday.", tags: ["vacation"] });
    const result = await host.invoke<TagsResult>("memory.tags");
    expect(result.tags.map((tag) => [tag.slug, tag.count])).toEqual([
      ["nightstash", 2],
      ["vacation", 1],
      ["work", 1],
    ]);
    expect(result.tags[0]!.colour).toMatch(/^#[0-9a-f]{6}$/i);
  });
});
