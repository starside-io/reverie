import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SetTagsResult } from "../../../src/tools/write/set-tags.js";
import { testHost, type TestHost } from "../../test-host.js";
import { ftsHits } from "../../domain/library.js";
import { NOW, remember, versions } from "./helpers.js";

describe("memory.set_tags", () => {
  let host: TestHost;

  beforeEach(async () => {
    host = await testHost({ now: NOW });
  });
  afterEach(async () => {
    await host.close();
  });

  const setTags = (input: Record<string, unknown>) => host.invoke<SetTagsResult>("memory.set_tags", input);

  it("attaches and detaches on one memory in one version, normalising every slug", async () => {
    const first = await remember(host, { shelf: "WRK/NST", body: "Pricing stays flat for the first year.", tags: ["pricing", "work"] });
    const result = await setTags({ action: "memory", call: first.memory.call, attach: ["#NightStash", "nightstash"], detach: ["#Work"] });

    expect(result).toMatchObject({ action: "memory", added: ["nightstash"], removed: ["work"], tags: ["nightstash", "pricing"], changed: true });
    expect(await host.db.tag.count({ where: { slug: "nightstash" } })).toBe(1);
    expect(await host.db.tag.count({ where: { slug: "work" } })).toBe(1);

    const rows = await versions(host, first.memory.id);
    expect(rows.map((row) => row.operation)).toEqual(["create", "update"]);
    expect(rows[0]?.content?.tags).toEqual(["pricing", "work"]);
    expect(rows[1]?.content?.tags).toEqual(["nightstash", "pricing"]);
    expect(await ftsHits(host.db, "nightstash")).toHaveLength(1);
  });

  it("writes nothing when nothing changes, and refuses an empty or contradictory call", async () => {
    const first = await remember(host, { body: "Pricing stays flat for the first year.", tags: ["pricing"] });
    const same = await setTags({ action: "memory", call: first.memory.call, attach: ["#Pricing"] });
    expect(same).toMatchObject({ changed: false });
    expect(await versions(host, first.memory.id)).toHaveLength(1);

    await expect(setTags({ action: "memory", call: first.memory.call })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      setTags({ action: "memory", call: first.memory.call, attach: ["ns"], detach: ["#NS"] }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(setTags({ action: "memory", call: first.memory.call, attach: ["not a tag"] })).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("renames a tag across the vocabulary without touching a body", async () => {
    const first = await remember(host, { body: "Ships on Thursdays. #ns" });
    const result = await setTags({ action: "rename", from: "#NS", to: "#NightStash" });
    expect(result).toMatchObject({ action: "rename", from: "ns", to: "nightstash", memories: 1 });

    const row = await host.db.memory.findUniqueOrThrow({ where: { id: first.memory.id } });
    expect(row.body).toBe("Ships on Thursdays. #ns");
    expect(row.tagText).toBe("nightstash");
    await expect(setTags({ action: "rename", from: "nightstash", to: "pricing" })).resolves.toMatchObject({ to: "pricing" });
  });

  it("refuses a rename onto an existing tag, pointing at merge", async () => {
    await remember(host, { body: "Ships on Thursdays.", tags: ["ns", "nightstash"] });
    await expect(setTags({ action: "rename", from: "ns", to: "nightstash" })).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringContaining("Merge"),
    });
  });

  it("merges one tag into another and leaves no row on the old slug", async () => {
    const both = await remember(host, { body: "Ships on Thursdays.", tags: ["ns", "nightstash"] });
    const old = await remember(host, { body: "Pricing stays flat for the first year.", tags: ["#NS"] });
    await host.db.project.create({
      data: { slug: "nightstash", name: "NightStash", tag: { connect: { slug: "ns" } } },
    });

    const result = await setTags({ action: "merge", from: "#Ns", into: "#NightStash" });
    expect(result).toMatchObject({ action: "merge", from: "ns", into: "nightstash", moved: 1, alreadyTagged: 1 });

    expect(await host.db.tag.findUnique({ where: { slug: "ns" } })).toBeNull();
    const tag = await host.db.tag.findUniqueOrThrow({ where: { slug: "nightstash" } });
    expect(await host.db.memoryTag.count({ where: { tagId: tag.id } })).toBe(2);
    expect((await host.db.project.findUniqueOrThrow({ where: { slug: "nightstash" } })).tagId).toBe(tag.id);
    for (const memory of [both, old]) {
      expect((await host.db.memory.findUniqueOrThrow({ where: { id: memory.memory.id } })).tagText).toBe("nightstash");
    }
  });

  it("refuses while incognito is on", async () => {
    await remember(host, { body: "Ships on Thursdays.", tags: ["ns"] });
    host.setIncognito(true);
    await expect(setTags({ action: "rename", from: "ns", to: "nightstash" })).rejects.toMatchObject({ code: "refused" });
    expect(await host.db.tag.findUnique({ where: { slug: "ns" } })).not.toBeNull();
  });
});
