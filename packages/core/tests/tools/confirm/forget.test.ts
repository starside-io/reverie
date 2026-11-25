import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { reshelveMemory } from "../../../src/domain/catalogue/shelving.js";
import { buildExportSnapshot } from "../../../src/domain/transfer/export.js";
import type { ForgetToolResult } from "../../../src/tools/confirm/forget.js";
import type { RememberResult } from "../../../src/tools/write/remember.js";
import { ftsHits } from "../../domain/library.js";
import { auditStrings, testHost, type TestHost } from "../../test-host.js";

const NOW = new Date("2026-12-27T10:00:00.000Z");

describe("memory.forget", () => {
  let host: TestHost;

  beforeEach(async () => {
    host = await testHost({ now: NOW, session: { id: "session-1" } });
  });
  afterEach(async () => {
    await host.close();
  });

  async function christmas() {
    return host.invoke<RememberResult>("memory.remember", {
      kind: "episode",
      shelf: "LIF/GTH",
      occurredOn: "2026-12-24",
      body: "Hosted Christmas. The oven died, so we ordered pizza.",
    });
  }

  it("refuses without confirmedByUser: true, and nothing changes", async () => {
    const written = await christmas();
    for (const input of [{ call: written.memory.call }, { call: written.memory.call, confirmedByUser: false }]) {
      await expect(host.invoke("memory.forget", input)).rejects.toMatchObject({ code: "invalid_input" });
    }
    expect(await host.db.memory.count()).toBe(1);
    expect(host.events.filter((event) => event.name === "memory.memory.forgotten")).toEqual([]);
  });

  it("is real: no row, no FTS hit, no version content, absent from export", async () => {
    const written = await christmas();
    const result = await host.invoke<ForgetToolResult>("memory.forget", {
      call: written.memory.call,
      confirmedByUser: true,
    });

    expect(result.forgotten).toEqual({
      memoryId: written.memory.id,
      call: "LIF/GTH/2026-12-24/001",
      retiredNumbers: ["LIF/GTH/2026-12-24/001"],
    });
    expect(result.sourcesDeleted).toBe(1);
    expect(await host.db.memory.count()).toBe(0);
    expect(await ftsHits(host.db, "pizza")).toEqual([]);
    const versions = await host.db.memoryVersion.findMany({ where: { memoryId: written.memory.id } });
    expect(versions.length).toBeGreaterThan(0);
    expect(versions.every((version) => version.body === null && version.contentSha256 === null)).toBe(true);
    expect(JSON.stringify(await buildExportSnapshot(host.db))).not.toContain("pizza");
  });

  it("retires the number for good: the next memory that day takes the next sequence", async () => {
    const written = await christmas();
    await host.invoke("memory.forget", { call: written.memory.call, confirmedByUser: true });

    const next = await host.invoke<RememberResult>("memory.remember", {
      kind: "episode",
      shelf: "LIF/GTH",
      occurredOn: "2026-12-24",
      body: "Played charades after dinner.",
    });
    expect(next.memory.call).toBe("LIF/GTH/2026-12-24/002");
  });

  it("takes an old number and retires every number the memory held", async () => {
    const written = await christmas();
    await reshelveMemory(host.db, written.memory.call, { shelf: "LIF/HOM" }, { actor: "user" });

    const result = await host.invoke<ForgetToolResult>("memory.forget", {
      call: "LIF/GTH/2026-12-24/001",
      confirmedByUser: true,
    });
    expect(result.forgotten.retiredNumbers).toEqual(["LIF/GTH/2026-12-24/001", "LIF/HOM/2026-12-24/001"]);
    await expect(
      host.invoke("memory.forget", { call: "LIF/HOM/2026-12-24/001", confirmedByUser: true }),
    ).rejects.toMatchObject({ code: "not_found", detail: { forgotten: true } });
  });

  it("emits memory.memory.forgotten after the commit, with ids and numbers only", async () => {
    const written = await christmas();
    let rowsWhenEmitted = -1;
    const record = host.ports.bus.emit;
    host.ports.bus.emit = async (name, payload) => {
      rowsWhenEmitted = await host.db.memory.count();
      await record(name, payload);
    };

    await host.invoke("memory.forget", { call: written.memory.call, confirmedByUser: true });

    expect(rowsWhenEmitted).toBe(0);
    expect(host.events.at(-1)).toEqual({
      name: "memory.memory.forgotten",
      payload: {
        memoryId: written.memory.id,
        call: written.memory.call,
        retiredNumbers: [written.memory.call],
      },
    });
  });

  it("deletes a tag no other memory carries and no project points at, and keeps the rest", async () => {
    const written = await host.invoke<RememberResult>("memory.remember", {
      kind: "episode",
      shelf: "LIF/GTH",
      occurredOn: "2026-12-24",
      body: "Hosted Christmas. The oven died, so we ordered pizza.",
      tags: ["oven", "christmas", "nightstash"],
    });
    await host.invoke<RememberResult>("memory.remember", {
      kind: "fact",
      shelf: "LIF/GTH",
      body: "Christmas lunch is at Jane Doe's next time.",
      tags: ["christmas"],
    });
    const project = await host.db.tag.findUniqueOrThrow({ where: { slug: "nightstash" } });
    await host.db.project.create({ data: { slug: "nightstash", name: "Night Stash", tagId: project.id } });
    // A tag emptied by detaching on purpose stays: only forget cleans up.
    const other = await host.invoke<RememberResult>("memory.remember", {
      kind: "fact",
      shelf: "LIF/GTH",
      body: "Sam Rivera took the spare chairs home.",
    });
    await host.invoke("memory.set_tags", { action: "memory", call: other.memory.call, attach: ["leftovers"] });
    await host.invoke("memory.set_tags", { action: "memory", call: other.memory.call, detach: ["leftovers"] });

    const result = await host.invoke<ForgetToolResult>("memory.forget", { call: written.memory.call, confirmedByUser: true });

    expect(result.tagsDeleted).toBe(1);
    const slugs = (await host.db.tag.findMany({ select: { slug: true } })).map((tag) => tag.slug).sort();
    expect(slugs).toEqual(["christmas", "leftovers", "nightstash"]);
  });

  it("refuses while incognito is on", async () => {
    const written = await christmas();
    host.setIncognito(true);
    await expect(
      host.invoke("memory.forget", { call: written.memory.call, confirmedByUser: true }),
    ).rejects.toMatchObject({ code: "refused", detail: { incognito: true } });
    expect(await host.db.memory.count()).toBe(1);
  });

  it("audits as needs-ok with ids, never the body", async () => {
    const written = await christmas();
    await host.invoke("memory.forget", { call: written.memory.call, confirmedByUser: true });
    expect(host.audit.at(-1)).toMatchObject({
      tool: "memory.forget",
      kind: "needs-ok",
      ids: { memoryIds: [written.memory.id], calls: [written.memory.call] },
      detail: { sourcesDeleted: 1 },
    });
    expect(auditStrings(host).some((text) => text.includes("pizza"))).toBe(false);
  });
});
