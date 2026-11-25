import { afterEach, describe, expect, it } from "vitest";

import {
  callQueryWhere,
  compareCallNumbers,
  formatCallNumber,
  formatSeq,
  isCallNumber,
  issueCallNumber,
  matchesCallQuery,
  parseCallNumber,
  parseCallQuery,
  resolveCallNumber,
  validateCallNumber,
} from "../../../src/domain/catalogue/call-number.js";
import { reshelveMemory, resolveShelf } from "../../../src/domain/catalogue/shelving.js";
import { DomainError } from "../../../src/domain/errors.js";
import { createMemory } from "../../../src/domain/memories.js";
import { forgetMemory } from "../../../src/domain/versions.js";
import type { Silo } from "../../../src/storage/client.js";
import { episode, openLibrary, USER } from "../library.js";

let db: Silo | undefined;

afterEach(async () => {
  await db?.$disconnect();
  db = undefined;
});

describe("call number text", () => {
  it("formats with a three digit, zero padded sequence", () => {
    expect(formatSeq(1)).toBe("001");
    expect(formatSeq(42)).toBe("042");
    expect(formatSeq(999)).toBe("999");
    expect(() => formatSeq(0)).toThrow(DomainError);
    expect(() => formatSeq(1000)).toThrow(DomainError);
    expect(
      formatCallNumber({ section: "LIF", shelf: "GTH", occurredOn: "2026-12-24", seq: 1 }),
    ).toBe("LIF/GTH/2026-12-24/001");
    expect(
      formatCallNumber({
        section: "LIF",
        shelf: "GTH",
        occurredOn: new Date(Date.UTC(2026, 11, 24, 22, 0)),
        seq: 12,
      }),
    ).toBe("LIF/GTH/2026-12-24/012");
  });

  it("parses and validates", () => {
    expect(parseCallNumber("LIF/GTH/2026-12-24/001")).toEqual({
      section: "LIF",
      shelf: "GTH",
      day: "2026-12-24",
      occurredOn: new Date("2026-12-24T00:00:00.000Z"),
      seq: 1,
    });
    for (const bad of [
      "LIF/GTH/2026-12-24/01",
      "LIF/GTH/2026-12-24/1000",
      "LIF/GTH/2026-12-24/000",
      "lif/gth/2026-12-24/001",
      "LIF/GTH/2026-02-30/001",
      "LIF/GTH/001",
    ]) {
      expect(isCallNumber(bad)).toBe(false);
      expect(() => validateCallNumber(bad)).toThrow(DomainError);
    }
  });

  it("sorts as text in section, shelf, time, sequence order", () => {
    const numbers = [
      "WRK/NST/2026-01-02/001",
      "LIF/GTH/2026-12-24/010",
      "LIF/GTH/2026-12-24/002",
      "LIF/TRV/2025-06-01/001",
      "LIF/GTH/2025-12-24/999",
      "CRF/HOW/2027-01-01/001",
    ];
    const byText = [...numbers].sort(compareCallNumbers);
    const byParts = [...numbers].sort((a, b) => {
      const pa = parseCallNumber(a)!;
      const pb = parseCallNumber(b)!;
      return (
        pa.section.localeCompare(pb.section) ||
        pa.shelf.localeCompare(pb.shelf) ||
        pa.occurredOn.getTime() - pb.occurredOn.getTime() ||
        pa.seq - pb.seq
      );
    });
    expect(byText).toEqual(byParts);
  });
});

describe("call number queries", () => {
  it("reads prefixes as whole segments", () => {
    expect(parseCallQuery("WRK/NST").prefix).toBe("WRK/NST/");
    expect(parseCallQuery("LIF/GTH/2026-12").prefix).toBe("LIF/GTH/2026-12-");
    expect(parseCallQuery("LIF/GTH/2026").prefix).toBe("LIF/GTH/2026-");
    expect(parseCallQuery("LIF/GTH/2026-12-24").prefix).toBe("LIF/GTH/2026-12-24/");
    expect(parseCallQuery("LIF").prefix).toBe("LIF/");
    expect(parseCallQuery("*/*/2026-12-24")).toMatchObject({
      isPrefix: false,
      section: null,
      shelf: null,
      date: "2026-12-24",
    });
    for (const bad of ["", "lif", "LIF/GTH/2026-1", "LIF/GTH/2026-13", "A/B/C/D/E"]) {
      expect(() => parseCallQuery(bad)).toThrow(DomainError);
    }
  });

  it("matches in memory the way the filter matches in the silo", () => {
    expect(matchesCallQuery("LIF/GTH/2026-12", "LIF/GTH/2026-12-24/001")).toBe(true);
    expect(matchesCallQuery("LIF/GTH/2026-12", "LIF/GTH/2026-11-24/001")).toBe(false);
    expect(matchesCallQuery("WRK/NST", "WRK/NST/2026-01-02/003")).toBe(true);
    expect(matchesCallQuery("*/*/2026-12-24", "WRK/NST/2026-12-24/003")).toBe(true);
    expect(matchesCallQuery("*/*/2026-12-24", "WRK/NST/2026-12-25/003")).toBe(false);
  });

  it("finds by prefix and by wildcard in the silo", async () => {
    db = await openLibrary();
    await createMemory(db, episode({ shelf: "LIF/GTH", occurredOn: "2026-12-24" }), USER);
    await createMemory(db, episode({ shelf: "LIF/GTH", occurredOn: "2026-12-31" }), USER);
    await createMemory(db, episode({ shelf: "LIF/GTH", occurredOn: "2027-01-01" }), USER);
    await createMemory(db, episode({ shelf: "WRK/NST", occurredOn: "2026-12-24" }), USER);

    const numbers = async (query: string) =>
      (
        await db!.memory.findMany({
          where: callQueryWhere(query),
          orderBy: { callNumber: "asc" },
          select: { callNumber: true },
        })
      ).map((row) => row.callNumber);

    expect(await numbers("LIF/GTH/2026-12")).toEqual([
      "LIF/GTH/2026-12-24/001",
      "LIF/GTH/2026-12-31/001",
    ]);
    expect(await numbers("WRK/NST")).toEqual(["WRK/NST/2026-12-24/001"]);
    expect(await numbers("*/*/2026-12-24")).toEqual([
      "LIF/GTH/2026-12-24/001",
      "WRK/NST/2026-12-24/001",
    ]);
    expect(await numbers("LIF/*/2027")).toEqual(["LIF/GTH/2027-01-01/001"]);
    expect(await numbers("LIF/GTH/2026-12-24/001")).toEqual(["LIF/GTH/2026-12-24/001"]);
  });
});

describe("issuing", () => {
  it("issues 001, 002, 003 on one shelf and day and starts again on the next", async () => {
    db = await openLibrary();
    const a = await createMemory(db, episode(), USER);
    const b = await createMemory(db, episode(), USER);
    const c = await createMemory(db, episode(), USER);
    const d = await createMemory(db, episode({ occurredOn: "2026-12-25" }), USER);
    expect([a, b, c, d].map((m) => m.callNumber)).toEqual([
      "LIF/GTH/2026-12-24/001",
      "LIF/GTH/2026-12-24/002",
      "LIF/GTH/2026-12-24/003",
      "LIF/GTH/2026-12-25/001",
    ]);
    expect([a, b, c].map((m) => m.seq)).toEqual([1, 2, 3]);
  });

  it("keeps every number unique across the silo, and text order equals library order", async () => {
    db = await openLibrary();
    const inputs = [
      ["WRK/NST", "2026-03-01"],
      ["LIF/GTH", "2026-12-24"],
      ["LIF/GTH", "2026-12-24"],
      ["LIF/GTH", "2026-01-05"],
      ["CRF/HOW", "2026-12-24"],
      ["LIF/TRV", "2026-07-14"],
    ] as const;
    for (const [shelf, occurredOn] of inputs) {
      await createMemory(db, episode({ shelf, occurredOn }), USER);
    }
    const rows = await db.memory.findMany({
      include: { shelf: { include: { section: true } } },
      orderBy: { callNumber: "asc" },
    });
    expect(new Set(rows.map((row) => row.callNumber)).size).toBe(rows.length);
    const byParts = [...rows].sort(
      (a, b) =>
        compareCallNumbers(a.shelf.section.code, b.shelf.section.code) ||
        compareCallNumbers(a.shelf.code, b.shelf.code) ||
        a.occurredOn.getTime() - b.occurredOn.getTime() ||
        a.seq - b.seq,
    );
    expect(rows.map((row) => row.id)).toEqual(byParts.map((row) => row.id));
  });

  it("refuses entry 1000 on one shelf and day, naming the shelf and the date, never widening", async () => {
    db = await openLibrary();
    const shelf = await resolveShelf(db, "LIF/GTH");
    const day = new Date("2026-12-24T00:00:00.000Z");
    // 999 entries on one day, written straight to the table to keep the test fast.
    await db.memory.createMany({
      data: Array.from({ length: 999 }, (_, index) => ({
        callNumber: formatCallNumber({ section: "LIF", shelf: "GTH", occurredOn: day, seq: index + 1 }),
        shelfId: shelf.id,
        occurredOn: day,
        seq: index + 1,
        kind: "episode",
        title: `Imported note ${index + 1}`,
        body: "A bulk import landing on one shelf and one date.",
        trust: "stated",
        validFrom: day,
        lastConfirmedAt: day,
      })),
    });

    const attempt = createMemory(db, episode(), USER);
    await expect(attempt).rejects.toMatchObject({
      code: "refused",
      detail: { shelf: "LIF/GTH", occurredOn: "2026-12-24" },
    });
    await expect(createMemory(db, episode(), USER)).rejects.toThrow(/LIF\/GTH.*2026-12-24.*new shelf/);
    expect(await db.memory.count({ where: { callNumber: { contains: "/1000" } } })).toBe(0);
    expect(await db.memory.count()).toBe(999);

    // Another day on the same shelf is unaffected.
    const next = await createMemory(db, episode({ occurredOn: "2026-12-25" }), USER);
    expect(next.callNumber).toBe("LIF/GTH/2026-12-25/001");
  });

  it("never reissues a forgotten number", async () => {
    db = await openLibrary();
    const first = await createMemory(db, episode(), USER);
    await forgetMemory(db, first.id, USER);
    const second = await createMemory(db, episode(), USER);
    expect(first.callNumber).toBe("LIF/GTH/2026-12-24/001");
    expect(second.callNumber).toBe("LIF/GTH/2026-12-24/002");
  });

  it("never reissues a number that moved away", async () => {
    db = await openLibrary();
    const first = await createMemory(db, episode(), USER);
    await reshelveMemory(db, first.id, { shelf: "LIF/TRV" }, USER);
    const second = await createMemory(db, episode(), USER);
    expect(second.callNumber).toBe("LIF/GTH/2026-12-24/002");
  });

  it("checks the alias table even past the highest live sequence", async () => {
    db = await openLibrary();
    await db.callNumberAlias.create({
      data: { oldCallNumber: "LIF/GTH/2026-12-24/007", memoryId: null },
    });
    const shelf = await resolveShelf(db, "LIF/GTH");
    const issued = await db.$transaction((tx) =>
      issueCallNumber(tx, { shelfId: shelf.id, occurredOn: new Date("2026-12-24T00:00:00.000Z") }),
    );
    expect(issued.callNumber).toBe("LIF/GTH/2026-12-24/008");
  });
});

describe("resolving", () => {
  it("resolves the current number, an alias, a forgotten number and an unknown one", async () => {
    db = await openLibrary();
    const memory = await createMemory(db, episode(), USER);
    expect(await resolveCallNumber(db, memory.callNumber)).toEqual({
      status: "current",
      memoryId: memory.id,
      callNumber: memory.callNumber,
    });

    const moved = await reshelveMemory(db, memory.id, { shelf: "LIF/TRV" }, USER);
    expect(await resolveCallNumber(db, memory.callNumber)).toEqual({
      status: "alias",
      memoryId: memory.id,
      callNumber: moved.to,
      asked: memory.callNumber,
    });

    await forgetMemory(db, memory.id, USER);
    expect((await resolveCallNumber(db, memory.callNumber)).status).toBe("forgotten");
    expect((await resolveCallNumber(db, moved.to)).status).toBe("forgotten");
    expect((await resolveCallNumber(db, "LIF/GTH/2026-12-24/050")).status).toBe("unknown");
    await expect(resolveCallNumber(db, "not a number")).rejects.toThrow(DomainError);
  });
});
