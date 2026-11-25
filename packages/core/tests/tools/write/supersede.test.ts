import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { asOf } from "../../../src/domain/versions.js";
import type { SupersedeToolResult } from "../../../src/tools/write/supersede.js";
import { auditStrings, PEOPLE, testHost, type TestHost } from "../../test-host.js";
import { NOW, remember, versions } from "./helpers.js";

describe("memory.supersede", () => {
  let host: TestHost;

  beforeEach(async () => {
    host = await testHost({ now: NOW, session: { id: "session-1" } });
  });
  afterEach(async () => {
    await host.close();
  });

  const supersede = (input: Record<string, unknown>) => host.invoke<SupersedeToolResult>("memory.supersede", input);
  const address = () =>
    remember(host, { shelf: "LIF/HOM", occurredOn: "2026-01-10", body: "Lives on Elm Street. #home", tags: ["address"] });

  it("closes the old entry with validTo and shelves the replacement at its own date", async () => {
    const old = await address();
    const result = await supersede({ call: old.memory.call, body: "Lives on Oak Street.", occurredOn: "2026-12-20" });

    expect(result.old).toMatchObject({
      call: old.memory.call,
      state: "superseded",
      validTo: NOW.toISOString(),
      supersededBy: result.replacement.call,
    });
    expect(result.replacement).toMatchObject({
      call: "LIF/HOM/2026-12-20/001",
      state: "active",
      trust: "stated",
      kind: "fact",
      validFrom: NOW.toISOString(),
      validTo: null,
    });
    expect(result.replacement.tags).toEqual(["address", "home"]);
    expect(result.replacement.sources[0]).toMatchObject({ kind: "conversation", quote: "Lives on Oak Street." });
    expect(await host.db.memory.count()).toBe(2);
  });

  it("keeps the previous content readable through history and asOf", async () => {
    const old = await address();
    const result = await supersede({ call: old.memory.call, body: "Lives on Oak Street." });

    const oldRows = await versions(host, old.memory.id);
    expect(oldRows.map((row) => row.operation)).toEqual(["create", "supersede"]);
    expect(oldRows[0]?.content?.body).toContain("Elm Street");

    const then = await asOf(host.db, result.replacement.id, new Date("2026-06-01T00:00:00.000Z"));
    expect(then?.callNumber).toBe(old.memory.call);
    expect(then?.content?.body).toContain("Elm Street");
    const now = await asOf(host.db, old.memory.id, new Date("2026-12-28T00:00:00.000Z"));
    expect(now?.callNumber).toBe(result.replacement.call);
  });

  it("emits superseded and written after the commit, with no text", async () => {
    const old = await address();
    host.events.length = 0;
    const result = await supersede({ call: old.memory.call, body: "Lives on Oak Street." });
    expect(host.events).toEqual([
      {
        name: "memory.memory.superseded",
        payload: {
          memoryId: old.memory.id,
          call: old.memory.call,
          supersededById: result.replacement.id,
          supersededBy: result.replacement.call,
        },
      },
      {
        name: "memory.memory.written",
        payload: {
          memoryId: result.replacement.id,
          call: result.replacement.call,
          door: "direct",
          operation: "supersede",
          kind: "fact",
          trust: "stated",
        },
      },
    ]);
    expect(auditStrings(host).some((text) => text.includes("Oak"))).toBe(false);
  });

  it("runs discipline on the replacement and writes nothing when refused", async () => {
    const old = await address();
    await expect(supersede({ call: old.memory.call, body: "Moved to Oak Street yesterday." })).rejects.toMatchObject({
      code: "refused",
      detail: { findings: expect.arrayContaining([expect.objectContaining({ check: "relativeDate" })]) },
    });
    await expect(supersede({ call: old.memory.call, body: "The door code password: 88123x for Oak Street." })).rejects.toMatchObject({
      code: "refused",
      detail: { findings: expect.arrayContaining([expect.objectContaining({ check: "secret" })]) },
    });
    await expect(
      supersede({ call: old.memory.call, body: "Lives on Oak Street.", said: "the gate token=ghp_abcdefghijklmnopqrstuvwxyz0123456789" }),
    ).rejects.toMatchObject({ code: "refused" });
    expect(await host.db.memory.count()).toBe(1);
    expect(host.events.filter((event) => event.name === "memory.memory.superseded")).toEqual([]);
    const stored = await host.db.memory.findUniqueOrThrow({ where: { id: old.memory.id } });
    expect(stored.state).toBe("active");
  });

  it("never yields a procedure", async () => {
    const old = await address();
    await expect(supersede({ call: old.memory.call, kind: "procedure", body: "Always ask before moving." })).rejects.toMatchObject({
      code: "refused",
      message: expect.stringContaining("promote_procedure"),
    });
  });

  it("refuses an entry that is not active", async () => {
    const old = await address();
    await supersede({ call: old.memory.call, body: "Lives on Oak Street." });
    await expect(supersede({ call: old.memory.call, body: "Lives on Pine Street." })).rejects.toMatchObject({ code: "refused" });

    const other = await remember(host, { body: "Keeps a bike in the shed." });
    await host.invoke("memory.retire", { call: other.memory.call });
    await expect(supersede({ call: other.memory.call, body: "Keeps two bikes in the shed." })).rejects.toMatchObject({
      code: "refused",
    });
  });

  it("carries the people over unless told otherwise, names staying unresolved labels", async () => {
    host.primePeople([PEOPLE.jane]);
    const old = await remember(host, {
      kind: "episode",
      shelf: "LIF/GTH",
      occurredOn: "2026-12-24",
      body: "Christmas dinner at home.",
      attendees: [PEOPLE.jane.uri, "Sam Rivera"],
    });
    const carried = await supersede({ call: old.memory.call, body: "Christmas dinner at Jane's, not at home.", occurredOn: "2026-12-24" });
    expect(carried.replacement.attendees.map((ref) => ref.label)).toEqual(["Jane Doe", "Sam Rivera"]);
    expect(carried.replacement.attendees[1]).toMatchObject({ uri: null, status: "unresolved" });

    const changed = await host.invoke<SupersedeToolResult>(
      "memory.supersede",
      {
        call: carried.replacement.call,
        body: "Christmas dinner at Jane's with John Doe.",
        occurredOn: "2026-12-24",
        attendees: [PEOPLE.jane.uri, "John Doe"],
      },
      { now: new Date("2026-12-28T10:00:00.000Z") },
    );
    expect(changed.unresolved).toEqual(["John Doe"]);
    expect(changed.replacement.call).toBe("LIF/GTH/2026-12-24/003");
  });
});
