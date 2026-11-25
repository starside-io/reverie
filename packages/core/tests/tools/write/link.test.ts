import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { LinkToolResult } from "../../../src/tools/write/link.js";
import { testHost, type TestHost } from "../../test-host.js";
import { NOW, remember, versions } from "./helpers.js";

describe("memory.link", () => {
  let host: TestHost;

  beforeEach(async () => {
    host = await testHost({ now: NOW });
  });
  afterEach(async () => {
    await host.close();
  });

  const link = (input: Record<string, unknown>) => host.invoke<LinkToolResult>("memory.link", input);

  it("writes a MemoryLink with its relation, and no version", async () => {
    const a = await remember(host, { body: "Deploys go out on Thursdays." });
    const b = await remember(host, { body: "Deploys are frozen in the last week of December." });
    const result = await link({ from: b.memory.call, to: a.memory.call, relation: "elaborates" });

    expect(result.link).toMatchObject({
      relation: "elaborates",
      fromId: b.memory.id,
      toId: a.memory.id,
      from: b.memory.call,
      to: a.memory.call,
    });
    expect(await host.db.memoryLink.count()).toBe(1);
    expect(await versions(host, a.memory.id)).toHaveLength(1);
    expect(host.audit.at(-1)).toMatchObject({ ids: { memoryIds: [b.memory.id, a.memory.id] } });
  });

  it("refuses a self link, also through an old number", async () => {
    const a = await remember(host, { body: "Deploys go out on Thursdays." });
    await expect(link({ from: a.memory.call, to: a.memory.call, relation: "contradicts" })).rejects.toMatchObject({
      code: "refused",
    });
    await host.invoke("memory.shelve", { action: "move", call: a.memory.call, shelf: "WRK/NST" });
    await expect(
      link({ from: a.memory.call, to: "WRK/NST/2026-12-27/001", relation: "elaborates" }),
    ).rejects.toMatchObject({ code: "refused" });
    expect(await host.db.memoryLink.count()).toBe(0);
  });

  it("refuses a duplicate, and contradicts reads the same both ways", async () => {
    const a = await remember(host, { body: "Deploys go out on Thursdays." });
    const b = await remember(host, { body: "Deploys go out on Mondays." });
    await link({ from: a.memory.call, to: b.memory.call, relation: "contradicts" });
    await expect(link({ from: a.memory.call, to: b.memory.call, relation: "contradicts" })).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(link({ from: b.memory.call, to: a.memory.call, relation: "contradicts" })).rejects.toMatchObject({
      code: "conflict",
    });
    // Another relation on the same pair is its own link; derived-from has a direction.
    await link({ from: b.memory.call, to: a.memory.call, relation: "derived-from" });
    await link({ from: a.memory.call, to: b.memory.call, relation: "derived-from" });
    expect(await host.db.memoryLink.count()).toBe(3);
  });

  it("refuses an unknown relation and an unknown number", async () => {
    const a = await remember(host, { body: "Deploys go out on Thursdays." });
    await expect(link({ from: a.memory.call, to: a.memory.call, relation: "likes" })).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(link({ from: a.memory.call, to: "LIF/GTH/2026-12-24/001", relation: "elaborates" })).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("refuses while incognito is on", async () => {
    const a = await remember(host, { body: "Deploys go out on Thursdays." });
    const b = await remember(host, { body: "Deploys go out on Mondays." });
    host.setIncognito(true);
    await expect(link({ from: a.memory.call, to: b.memory.call, relation: "contradicts" })).rejects.toMatchObject({
      code: "refused",
    });
  });
});
