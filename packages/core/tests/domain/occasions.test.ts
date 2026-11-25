import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createMemory } from "../../src/domain/memories.js";
import { linkOccasion, participantsFrom } from "../../src/domain/occasions.js";
import { history } from "../../src/domain/versions.js";
import type { Silo } from "../../src/storage/client.js";
import { episode, openLibrary, USER } from "./library.js";

const OCCASION = "module://people/event/e_8812";
const JANE = "module://people/person/p_jane";
const SAM = "module://people/person/p_sam";

describe("participantsFrom", () => {
  it("reads URIs and objects, never a bare name as a person", () => {
    expect(
      participantsFrom({
        participants: [JANE, { id: "p_sam", name: "Sam Rivera" }, "Jane Doe", { name: "No Id" }, 7],
      }),
    ).toEqual([
      { uri: JANE, label: JANE },
      { uri: SAM, label: "Sam Rivera" },
    ]);
    expect(participantsFrom({ attendees: [] })).toEqual([]);
    expect(participantsFrom({ title: "Christmas" })).toBeNull();
    expect(participantsFrom(undefined)).toBeNull();
  });
});

describe("linkOccasion", () => {
  let db: Silo;

  beforeEach(async () => {
    db = await openLibrary();
  });
  afterEach(async () => {
    await db.$disconnect();
  });

  it("records the occasion, syncs attendees when given, and writes one version per change", async () => {
    const memory = await createMemory(
      db,
      episode({ refs: [{ role: "attendee", label: "Sam Rivera" }, { role: "attendee", label: "A Neighbour" }] }),
      USER,
    );

    const unsynced = await linkOccasion(db, memory.id, { uri: OCCASION, label: "Christmas", attendees: null }, USER);
    expect(unsynced).toMatchObject({ changed: true, added: [], keptNames: [] });

    const synced = await linkOccasion(
      db,
      memory.id,
      { uri: OCCASION, label: "Christmas", attendees: [{ uri: SAM, label: "Sam Rivera" }, { uri: JANE, label: "Jane Doe" }] },
      USER,
    );
    expect(synced).toMatchObject({ resolvedNames: ["Sam Rivera"], keptNames: ["A Neighbour"], added: [SAM, JANE] });

    const same = await linkOccasion(
      db,
      memory.id,
      { uri: OCCASION, label: "Christmas", attendees: [{ uri: SAM, label: "Sam Rivera" }, { uri: JANE, label: "Jane Doe" }] },
      USER,
    );
    expect(same.changed).toBe(false);
    expect((await history(db, memory.id)).map((row) => row.operation)).toEqual(["create", "update", "update"]);

    const refs = await db.memoryRef.findMany({ where: { memoryId: memory.id }, orderBy: { label: "asc" } });
    expect(refs.map((ref) => [ref.role, ref.uri, ref.label])).toEqual([
      ["attendee", null, "A Neighbour"],
      ["occasion", OCCASION, "Christmas"],
      ["attendee", JANE, "Jane Doe"],
      ["attendee", SAM, "Sam Rivera"],
    ]);
  });

  it("refuses a URI that is not an occasion", async () => {
    const memory = await createMemory(db, episode(), USER);
    await expect(linkOccasion(db, memory.id, { uri: JANE, label: "Jane", attendees: null }, USER)).rejects.toMatchObject({
      code: "invalid_input",
    });
  });
});
