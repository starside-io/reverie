import { afterEach, describe, expect, it } from "vitest";

import {
  createMemory,
  pinMemory,
  retireMemory,
  supersedeMemory,
  touchMemory,
  updateMemory,
} from "../../src/domain/memories.js";
import { history } from "../../src/domain/versions.js";
import type { Silo } from "../../src/storage/client.js";
import { episode, openLibrary, USER } from "./library.js";

let db: Silo | undefined;

afterEach(async () => {
  await db?.$disconnect();
  db = undefined;
});

async function open(): Promise<Silo> {
  db = await openLibrary();
  return db;
}

describe("createMemory", () => {
  it("refuses a memory with no source, and writes nothing", async () => {
    const silo = await open();
    await expect(createMemory(silo, episode({ sources: [] }), USER)).rejects.toMatchObject({
      code: "refused",
      message: expect.stringContaining("No source, no memory"),
    });
    const { sources: _dropped, ...noSources } = episode();
    await expect(createMemory(silo, noSources as never, USER)).rejects.toMatchObject({ code: "refused" });
    expect(await silo.memory.count()).toBe(0);
    expect(await silo.memoryVersion.count()).toBe(0);
  });

  it("writes the row, tags, refs, sources and the create version in one go", async () => {
    const silo = await open();
    const memory = await createMemory(
      silo,
      episode({
        tags: ["christmas"],
        refs: [
          { role: "attendee", label: "Jane Doe", uri: "module://people/person/jane" },
          { role: "attendee", label: "Sam Rivera" },
        ],
        importance: 4,
      }),
      { actor: "user", at: new Date("2026-12-27T10:00:00Z") },
    );
    expect(memory).toMatchObject({
      callNumber: "LIF/GTH/2026-12-24/001",
      seq: 1,
      state: "active",
      scope: "global",
      scopeRef: null,
      importance: 4,
      trust: "stated",
      tagText: "christmas",
    });
    expect(memory.occurredOn.toISOString()).toBe("2026-12-24T00:00:00.000Z");
    expect(memory.validFrom.toISOString()).toBe("2026-12-24T00:00:00.000Z");
    expect(memory.lastConfirmedAt.toISOString()).toBe("2026-12-27T10:00:00.000Z");

    const refs = await silo.memoryRef.findMany({ where: { memoryId: memory.id }, orderBy: { label: "asc" } });
    expect(refs.map((ref) => [ref.label, ref.resolved, ref.uri])).toEqual([
      ["Jane Doe", true, "module://people/person/jane"],
      ["Sam Rivera", false, null],
    ]);
    const sources = await silo.memorySource.findMany({ where: { memoryId: memory.id }, include: { source: true } });
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ quote: "we had everyone over for Christmas", source: { kind: "conversation" } });
    expect((await history(silo, memory.id)).map((v) => v.operation)).toEqual(["create"]);
  });

  it("rolls everything back when one part fails", async () => {
    const silo = await open();
    await expect(
      createMemory(
        silo,
        episode({ sources: [{ sourceId: "00000000-0000-4000-8000-000000000000", quote: "gone" }] }),
        USER,
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(await silo.memory.count()).toBe(0);
    expect(await silo.memoryVersion.count()).toBe(0);
  });

  it("refuses bad input with the field named", async () => {
    const silo = await open();
    await expect(createMemory(silo, episode({ importance: 9 }), USER)).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("importance"),
    });
    await expect(
      createMemory(silo, episode({ sources: [{ source: { kind: "page", label: "x", trust: "external" }, quote: "q".repeat(501) }] }), USER),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(createMemory(silo, episode({ shelf: "LIF/XYZ" }), USER)).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("scopes a memory to a project", async () => {
    const silo = await open();
    const memory = await createMemory(
      silo,
      episode({ shelf: "WRK/NST", kind: "fact", scope: "project", scopeRef: "nightstash" }),
      USER,
    );
    expect(memory).toMatchObject({ scope: "project", scopeRef: "nightstash" });
  });
});

describe("updateMemory", () => {
  it("writes a new version under the same number, and nothing when nothing changed", async () => {
    const silo = await open();
    const memory = await createMemory(silo, episode(), USER);
    const updated = await updateMemory(silo, memory.callNumber, { title: "Christmas Eve at home" }, USER);
    expect(updated.changed).toBe(true);
    expect(updated.memory.callNumber).toBe(memory.callNumber);
    expect(updated.memory.title).toBe("Christmas Eve at home");

    const same = await updateMemory(silo, memory.id, { title: "Christmas Eve at home" }, USER);
    expect(same.changed).toBe(false);
    expect((await history(silo, memory.id)).map((v) => v.operation)).toEqual(["create", "update"]);
  });

  it("refuses to edit a superseded entry", async () => {
    const silo = await open();
    const memory = await createMemory(silo, episode(), USER);
    await supersedeMemory(silo, memory.id, episode({ occurredOn: "2026-12-26" }), {
      actor: "user",
      at: new Date("2026-12-27T10:00:00Z"),
    });
    await expect(updateMemory(silo, memory.id, { title: "Changed" }, USER)).rejects.toMatchObject({
      code: "refused",
    });
  });
});

describe("supersedeMemory", () => {
  it("shelves the replacement at its own date on the old shelf by default", async () => {
    const silo = await open();
    const old = await createMemory(silo, episode({ kind: "preference", shelf: "CRF/HOW", occurredOn: "2026-01-10" }), USER);
    const { old: closed, replacement } = await supersedeMemory(
      silo,
      old.id,
      episode({ kind: "preference", shelf: undefined, occurredOn: "2026-11-20" }),
      USER,
    );
    expect(replacement.callNumber).toBe("CRF/HOW/2026-11-20/001");
    expect(closed).toMatchObject({ state: "superseded", supersededById: replacement.id, callNumber: old.callNumber });
    expect(closed.validTo).toEqual(replacement.validFrom);
    await expect(supersedeMemory(silo, old.id, episode(), USER)).rejects.toMatchObject({ code: "refused" });
  });

  it("refuses a replacement with no source", async () => {
    const silo = await open();
    const old = await createMemory(silo, episode(), USER);
    await expect(supersedeMemory(silo, old.id, episode({ sources: [] }), USER)).rejects.toMatchObject({
      code: "refused",
    });
    expect((await silo.memory.findUniqueOrThrow({ where: { id: old.id } })).state).toBe("active");
  });
});

describe("retire, touch, pin", () => {
  it("retires an active entry once", async () => {
    const silo = await open();
    const memory = await createMemory(silo, episode(), USER);
    expect((await retireMemory(silo, memory.id, USER)).state).toBe("retired");
    await expect(retireMemory(silo, memory.id, USER)).rejects.toMatchObject({ code: "refused" });
  });

  it("touch moves lastConfirmedAt and writes no version", async () => {
    const silo = await open();
    const memory = await createMemory(silo, episode(), USER);
    const at = new Date("2027-02-01T09:00:00Z");
    expect((await touchMemory(silo, memory.id, { at })).lastConfirmedAt).toEqual(at);
    expect(await history(silo, memory.id)).toHaveLength(1);
  });

  it("pins and unpins, a version per change", async () => {
    const silo = await open();
    const memory = await createMemory(silo, episode(), USER);
    expect((await pinMemory(silo, memory.id, true, USER)).pinned).toBe(true);
    await pinMemory(silo, memory.id, true, USER);
    expect((await pinMemory(silo, memory.id, false, USER)).pinned).toBe(false);
    expect((await history(silo, memory.id)).map((v) => v.operation)).toEqual(["create", "update", "update"]);
  });
});
