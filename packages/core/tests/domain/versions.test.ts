import { afterEach, describe, expect, it } from "vitest";

import { resolveCallNumber } from "../../src/domain/catalogue/call-number.js";
import { reshelveMemory } from "../../src/domain/catalogue/shelving.js";
import {
  createMemory,
  pinMemory,
  retireMemory,
  supersedeMemory,
  updateMemory,
} from "../../src/domain/memories.js";
import {
  asOf,
  forgetMemory,
  history,
  redactMemory,
  serialiseContent,
  sha256,
} from "../../src/domain/versions.js";
import type { Silo } from "../../src/storage/client.js";
import { episode, ftsHits, openLibrary, USER } from "./library.js";

let db: Silo | undefined;

afterEach(async () => {
  await db?.$disconnect();
  db = undefined;
});

async function open(): Promise<Silo> {
  db = await openLibrary();
  return db;
}

const T = (iso: string) => new Date(iso);

describe("supersede, never overwrite", () => {
  it("appends one immutable version per mutation, with its hash", async () => {
    const silo = await open();
    const memory = await createMemory(silo, episode(), { actor: "user", at: T("2026-12-27T10:00:00Z") });
    await updateMemory(
      silo,
      memory.id,
      { body: "Hosted Christmas with Jane Doe and John Doe." },
      { actor: "proposal:p1", at: T("2026-12-28T10:00:00Z"), operation: "refine" },
    );
    await pinMemory(silo, memory.id, true, { actor: "user", at: T("2026-12-29T10:00:00Z") });
    await retireMemory(silo, memory.id, { actor: "user", at: T("2026-12-30T10:00:00Z") });

    const rows = await history(silo, memory.id);
    expect(rows.map((v) => [v.operation, v.actor])).toEqual([
      ["create", "user"],
      ["refine", "proposal:p1"],
      ["update", "user"],
      ["retire", "user"],
    ]);
    expect(rows[0]!.content!.body).toBe("Hosted Christmas with Jane Doe, John Doe and Sam Rivera.");
    expect(rows[1]!.content!.body).toBe("Hosted Christmas with Jane Doe and John Doe.");
    expect(rows[2]!.content!.pinned).toBe(true);
    expect(rows[3]!.content!.state).toBe("retired");
    for (const row of rows) {
      expect(row.contentSha256).toBe(sha256(serialiseContent(row.content!)));
      expect(row.content!.callNumber).toBe(memory.callNumber);
    }
  });

  it("keeps history in order when two writes land in the same millisecond", async () => {
    const silo = await open();
    const at = T("2026-12-27T10:00:00Z");
    const memory = await createMemory(silo, episode(), { actor: "user", at });
    await updateMemory(silo, memory.id, { title: "Christmas, again" }, { actor: "user", at });
    const rows = await history(silo, memory.id);
    expect(rows.map((v) => v.operation)).toEqual(["create", "update"]);
    expect(rows[1]!.at.getTime()).toBeGreaterThan(rows[0]!.at.getTime());
  });

  it("asOf reads what the memory said at a time", async () => {
    const silo = await open();
    const memory = await createMemory(silo, episode({ kind: "fact", title: "Sam lives in Leeds", body: "Sam Rivera lives in Leeds." }), {
      actor: "user",
      at: T("2026-12-27T10:00:00Z"),
    });
    await updateMemory(silo, memory.id, { body: "Sam Rivera lives in Leeds, near the station." }, {
      actor: "user",
      at: T("2027-01-10T10:00:00Z"),
    });

    expect((await asOf(silo, memory.id, T("2027-01-01T00:00:00Z")))!.content!.body).toBe(
      "Sam Rivera lives in Leeds.",
    );
    expect((await asOf(silo, memory.id, T("2027-02-01T00:00:00Z")))!.content!.body).toBe(
      "Sam Rivera lives in Leeds, near the station.",
    );
    // Valid from the day it happened, even though it was written later.
    expect((await asOf(silo, memory.id, T("2026-12-25T00:00:00Z")))!.content!.body).toBe(
      "Sam Rivera lives in Leeds.",
    );
    expect(await asOf(silo, memory.id, T("2026-12-01T00:00:00Z"))).toBeNull();
  });

  it("asOf follows a supersede chain from either end", async () => {
    const silo = await open();
    const old = await createMemory(
      silo,
      episode({ kind: "fact", shelf: "LIF/HOM", occurredOn: "2026-01-01", title: "Address", body: "Jane Doe lives on Elm Street." }),
      { actor: "user", at: T("2026-01-02T00:00:00Z") },
    );
    const { old: closed, replacement } = await supersedeMemory(
      silo,
      old.callNumber,
      episode({ kind: "fact", shelf: undefined, occurredOn: "2027-03-01", title: "Address", body: "Jane Doe lives on Oak Lane." }),
      { actor: "user", at: T("2027-03-02T00:00:00Z") },
    );

    expect(closed.state).toBe("superseded");
    expect(closed.validTo).toEqual(T("2027-03-02T00:00:00Z"));
    expect(closed.supersededById).toBe(replacement.id);
    expect(closed.callNumber).toBe(old.callNumber);
    expect(replacement.callNumber).toBe("LIF/HOM/2027-03-01/001");
    expect(replacement.validFrom).toEqual(T("2027-03-02T00:00:00Z"));

    for (const start of [old.id, replacement.id]) {
      expect((await asOf(silo, start, T("2026-06-01T00:00:00Z")))!.content!.body).toBe(
        "Jane Doe lives on Elm Street.",
      );
      expect((await asOf(silo, start, T("2027-06-01T00:00:00Z")))!.content!.body).toBe(
        "Jane Doe lives on Oak Lane.",
      );
    }
    // The previous content is still readable through history.
    const oldHistory = await history(silo, old.id);
    expect(oldHistory.map((v) => v.operation)).toEqual(["create", "supersede"]);
    expect(oldHistory[0]!.content!.body).toBe("Jane Doe lives on Elm Street.");
  });

  it("redacts the past of a memory that stays, keeping operation, actor and time", async () => {
    const silo = await open();
    const memory = await createMemory(silo, episode(), { actor: "user", at: T("2026-12-27T10:00:00Z") });
    await updateMemory(silo, memory.id, { body: "Hosted Christmas." }, { actor: "user", at: T("2026-12-28T10:00:00Z") });

    const result = await redactMemory(silo, memory.id, { actor: "user", at: T("2026-12-29T10:00:00Z") });
    expect(result.redacted).toBe(1);
    const rows = await history(silo, memory.id);
    expect(rows.map((v) => [v.operation, v.actor, v.at.toISOString(), v.content === null, v.contentSha256 === null])).toEqual([
      ["create", "user", "2026-12-27T10:00:00.000Z", true, true],
      ["update", "user", "2026-12-28T10:00:00.000Z", false, false],
      ["redact", "user", "2026-12-29T10:00:00.000Z", true, true],
    ]);
    expect(rows[1]!.content!.body).toBe("Hosted Christmas.");
  });
});

describe("forget is real", () => {
  it("leaves no row, no FTS hit, no version content, and the number points at nothing", async () => {
    const silo = await open();
    const memory = await createMemory(
      silo,
      episode({ body: "Sam Rivera brought a pavlova. #dessert", tags: ["christmas"], refs: [{ role: "attendee", label: "Sam Rivera" }] }),
      USER,
    );
    await updateMemory(silo, memory.id, { title: "Pavlova night" }, USER);
    const moved = await reshelveMemory(silo, memory.id, { shelf: "LIF/TRV" }, USER);
    expect(await ftsHits(silo, "pavlova")).toHaveLength(1);

    const result = await forgetMemory(silo, moved.to, USER);
    expect(result.retiredNumbers).toEqual([memory.callNumber, moved.to].sort());
    expect(result.sourcesDeleted).toBe(1);

    expect(await silo.memory.findUnique({ where: { id: memory.id } })).toBeNull();
    expect(await ftsHits(silo, "pavlova")).toEqual([]);
    expect(await ftsHits(silo, "dessert")).toEqual([]);
    expect(await silo.memoryTag.count({ where: { memoryId: memory.id } })).toBe(0);
    expect(await silo.memoryRef.count({ where: { memoryId: memory.id } })).toBe(0);
    expect(await silo.memorySource.count({ where: { memoryId: memory.id } })).toBe(0);
    expect(await silo.source.count()).toBe(0);

    const rows = await history(silo, memory.id);
    expect(rows.map((v) => v.operation)).toEqual(["create", "update", "shelve", "forget"]);
    expect(rows.every((v) => v.content === null && v.contentSha256 === null)).toBe(true);
    const raw = await silo.memoryVersion.findMany({ where: { memoryId: memory.id } });
    expect(raw.every((v) => v.body === null && v.contentSha256 === null && v.actor === "user")).toBe(true);

    const aliases = await silo.callNumberAlias.findMany({ orderBy: { oldCallNumber: "asc" } });
    expect(aliases).toEqual([
      expect.objectContaining({ oldCallNumber: memory.callNumber, memoryId: null }),
      expect.objectContaining({ oldCallNumber: moved.to, memoryId: null }),
    ]);
    for (const number of [memory.callNumber, moved.to]) {
      expect((await resolveCallNumber(silo, number)).status).toBe("forgotten");
    }
    const reissued = await createMemory(silo, episode({ shelf: "LIF/TRV" }), USER);
    expect(reissued.callNumber).toBe("LIF/TRV/2026-12-24/002");
  });

  it("keeps a source another memory still cites", async () => {
    const silo = await open();
    const first = await createMemory(silo, episode(), USER);
    const shared = await silo.memorySource.findFirstOrThrow({ where: { memoryId: first.id } });
    const second = await createMemory(
      silo,
      episode({ sources: [{ sourceId: shared.sourceId, quote: "everyone over" }] }),
      USER,
    );
    const result = await forgetMemory(silo, first.id, USER);
    expect(result.sourcesDeleted).toBe(0);
    expect(await silo.source.findUnique({ where: { id: shared.sourceId } })).not.toBeNull();
    expect(await silo.memorySource.count({ where: { memoryId: second.id } })).toBe(1);
  });

  it("refuses to forget what is already gone", async () => {
    const silo = await open();
    const memory = await createMemory(silo, episode(), USER);
    await forgetMemory(silo, memory.callNumber, USER);
    await expect(forgetMemory(silo, memory.callNumber, USER)).rejects.toMatchObject({ code: "not_found" });
  });
});
