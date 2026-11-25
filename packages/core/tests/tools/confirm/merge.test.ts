import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { reshelveMemory } from "../../../src/domain/catalogue/shelving.js";
import { history } from "../../../src/domain/versions.js";
import type { MergeToolResult } from "../../../src/tools/confirm/merge.js";
import type { GetResult } from "../../../src/tools/read/get.js";
import type { ExportResult } from "../../../src/tools/read/export.js";
import type { HistoryResult } from "../../../src/tools/read/history.js";
import type { RememberResult } from "../../../src/tools/write/remember.js";
import { ftsHits } from "../../domain/library.js";
import { auditStrings, PEOPLE, testHost, type TestHost } from "../../test-host.js";

const NOW = new Date("2026-12-27T10:00:00.000Z");

describe("memory.merge", () => {
  let host: TestHost;

  beforeEach(async () => {
    host = await testHost({ now: NOW, session: { id: "session-1" } });
  });
  afterEach(async () => {
    await host.close();
  });

  async function pair() {
    const survivor = await host.invoke<RememberResult>("memory.remember", {
      kind: "episode",
      shelf: "LIF/GTH",
      occurredOn: "2026-12-24",
      body: "Hosted Christmas at home.",
      tags: ["christmas"],
      attendees: ["Jane Doe"],
    });
    const absorbed = await host.invoke<RememberResult>("memory.remember", {
      kind: "episode",
      shelf: "LIF/GTH",
      occurredOn: "2026-12-24",
      body: "The oven died, so pizza was ordered. #hosting",
      said: "the oven died and we got pizza",
      attendees: ["Sam Rivera", "Jane Doe"],
    });
    return { survivor: survivor.memory, absorbed: absorbed.memory };
  }

  const merge = (survivor: string, absorbed: string) =>
    host.invoke<MergeToolResult>("memory.merge", { survivor, absorbed, confirmedByUser: true });

  it("refuses without confirmedByUser: true, and nothing changes", async () => {
    const { survivor, absorbed } = await pair();
    await expect(host.invoke("memory.merge", { survivor: survivor.call, absorbed: absorbed.call })).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(await host.db.memory.count()).toBe(2);
  });

  it("keeps both sets of sources and tags, and the people of both", async () => {
    const { survivor, absorbed } = await pair();
    const result = await merge(survivor.call, absorbed.call);

    expect(result.memory.call).toBe(survivor.call);
    expect(result.memory.sources.map((s) => s.quote).sort()).toEqual(["Hosted Christmas at home.", "the oven died and we got pizza"]);
    expect(result.memory.tags).toEqual(["christmas", "hosting"]);
    expect(result.memory.attendees.map((a) => a.label)).toEqual(["Jane Doe", "Sam Rivera"]);
    expect(result).toMatchObject({ sourcesAdded: 1, tagsAdded: ["hosting"], refsAdded: 1 });
    expect(await host.db.memory.count()).toBe(1);
    expect(await host.db.source.count()).toBe(2);
  });

  it("the absorbed number and all its old numbers become aliases of the survivor, never reissued", async () => {
    const { survivor, absorbed } = await pair();
    await reshelveMemory(host.db, absorbed.call, { shelf: "LIF/HOM" }, { actor: "user" });
    const moved = "LIF/HOM/2026-12-24/001";

    const result = await merge(survivor.call, moved);
    expect(result.absorbed).toEqual({ memoryId: absorbed.id, call: moved, aliases: [absorbed.call, moved] });

    for (const call of [absorbed.call, moved]) {
      const got = await host.invoke<GetResult>("memory.get", { call });
      expect(got).toMatchObject({ moved: true, memory: { id: survivor.id, call: survivor.call } });
    }

    const next = await host.invoke<RememberResult>("memory.remember", {
      kind: "episode",
      shelf: "LIF/HOM",
      occurredOn: "2026-12-24",
      body: "Washed up after dinner.",
    });
    expect(next.memory.call).toBe("LIF/HOM/2026-12-24/002");
  });

  it("writes versions, and removes the absorbed row without forgetting it: its history keeps its content", async () => {
    const { survivor, absorbed } = await pair();
    await merge(survivor.call, absorbed.call);

    expect(await host.db.memory.findUnique({ where: { id: absorbed.id } })).toBeNull();
    const gone = await history(host.db, absorbed.id);
    expect(gone.map((v) => v.operation)).toEqual(["create", "merge"]);
    expect(gone.every((v) => v.content !== null)).toBe(true);
    expect(gone[0]?.content?.body).toBe("The oven died, so pizza was ordered. #hosting");
    expect(gone[1]?.content).toMatchObject({ state: "superseded", supersededById: survivor.id });
    expect(await host.db.memoryVersion.count({ where: { memoryId: absorbed.id, operation: "forget" } })).toBe(0);

    const kept = await history(host.db, survivor.id);
    expect(kept.map((v) => v.operation)).toEqual(["create", "merge"]);
    expect(kept[1]?.content?.tags).toEqual(["christmas", "hosting"]);

    // The survivor is found by the absorbed memory's tag; the absorbed body has no index entry of its own.
    expect(await ftsHits(host.db, "hosting")).toHaveLength(1);
    expect(await ftsHits(host.db, "pizza")).toEqual([]);
  });

  it("moves links to the survivor", async () => {
    const { survivor, absorbed } = await pair();
    const third = await host.invoke<RememberResult>("memory.remember", { kind: "fact", body: "Christmas dinner was at seven." });
    await host.db.memoryLink.create({ data: { fromId: absorbed.id, toId: third.memory.id, relation: "elaborates" } });
    await host.db.memoryLink.create({ data: { fromId: absorbed.id, toId: survivor.id, relation: "elaborates" } });
    const result = await merge(survivor.call, absorbed.call);
    expect(result.linksMoved).toBe(1);
    expect(await host.db.memoryLink.findMany({ select: { fromId: true, toId: true } })).toEqual([
      { fromId: survivor.id, toId: third.memory.id },
    ]);
  });

  it("refuses a memory merged into itself, and a superseded or missing one", async () => {
    const { survivor } = await pair();
    await expect(merge(survivor.call, survivor.call)).rejects.toMatchObject({ code: "invalid_input" });
    await expect(merge(survivor.call, "LIF/GTH/2026-12-25/001")).rejects.toMatchObject({ code: "not_found" });
  });

  it("emits memory.memory.written for the survivor after the commit, with ids only", async () => {
    const { survivor, absorbed } = await pair();
    host.primePeople([PEOPLE.jane]);
    await merge(survivor.call, absorbed.call);
    expect(host.events.at(-1)).toEqual({
      name: "memory.memory.written",
      payload: {
        memoryId: survivor.id,
        call: survivor.call,
        door: "direct",
        operation: "merge",
        kind: "episode",
        trust: "stated",
        absorbedId: absorbed.id,
        absorbedCall: absorbed.call,
      },
    });
  });

  it("refuses while incognito is on", async () => {
    const { survivor, absorbed } = await pair();
    host.setIncognito(true);
    await expect(merge(survivor.call, absorbed.call)).rejects.toMatchObject({ code: "refused", detail: { incognito: true } });
    expect(await host.db.memory.count()).toBe(2);
  });

  it("audits as needs-ok with ids, never a body", async () => {
    const { survivor, absorbed } = await pair();
    await merge(survivor.call, absorbed.call);
    expect(host.audit.at(-1)).toMatchObject({
      tool: "memory.merge",
      kind: "needs-ok",
      ids: { memoryIds: [survivor.id, absorbed.id], calls: [survivor.call, absorbed.call] },
    });
    expect(auditStrings(host).some((text) => text.includes("pizza"))).toBe(false);
  });
});

describe("memory.merge through a snapshot", () => {
  const NOW_ROUND = new Date("2026-12-27T10:00:00.000Z");

  it("keeps the merge versions, the absorbed listing and asOf across export and a replace import", async () => {
    const source = await testHost({ now: NOW_ROUND, session: { id: "session-1" } });
    const target = await testHost({ now: NOW_ROUND, session: { id: "session-2" } });
    try {
      const survivor = await source.invoke<RememberResult>("memory.remember", {
        kind: "preference",
        shelf: "LIF/HOM",
        body: "Prefers oat milk in coffee.",
      });
      const absorbed = await source.invoke<RememberResult>("memory.remember", {
        kind: "preference",
        shelf: "LIF/HOM",
        body: "Likes oat milk lattes with cinnamon.",
      });
      await source.invoke(
        "memory.merge",
        { survivor: survivor.memory.call, absorbed: absorbed.memory.call, confirmedByUser: true },
        { now: new Date("2026-12-27T11:00:00.000Z") },
      );
      const { snapshot } = await source.invoke<ExportResult>("memory.export", {});
      expect(snapshot.versions.filter((version) => version.operation === "merge")).toHaveLength(2);

      const plan = await target.invoke<{ acknowledgement: string }>("memory.import", {
        snapshot,
        mode: "replace",
        dryRun: true,
        confirmedByUser: true,
      });
      await target.invoke("memory.import", { snapshot, mode: "replace", acknowledge: plan.acknowledgement, confirmedByUser: true });

      const after = await target.invoke<HistoryResult>("memory.history", { call: absorbed.memory.call });
      expect(after.mode).toBe("history");
      if (after.mode !== "history") return;
      expect(after.call).toBe(survivor.memory.call);
      expect(after.versions.map((version) => version.operation)).toEqual(["create", "merge"]);
      expect(after.absorbed).toEqual([
        expect.objectContaining({ call: absorbed.memory.call, versions: [expect.objectContaining({ operation: "create" }), expect.objectContaining({ operation: "merge" })] }),
      ]);
      const before = await target.invoke<HistoryResult>("memory.history", { call: survivor.memory.call, asOf: "2026-12-27T10:30:00.000Z" });
      expect(before).toMatchObject({ mode: "asOf", valid: { call: survivor.memory.call, version: { operation: "create" } } });
      const valid = await target.invoke<HistoryResult>("memory.history", { call: survivor.memory.call, asOf: "2026-12-27T11:30:00.000Z" });
      expect(valid).toMatchObject({ mode: "asOf", valid: { call: survivor.memory.call, version: { operation: "merge" } } });
    } finally {
      await source.close();
      await target.close();
    }
  });
});
