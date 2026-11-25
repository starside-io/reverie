import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { checkSilo } from "../../src/storage/check.js";
import { openSilo } from "../../src/storage/client.js";
import { migrateSilo } from "../../src/storage/migrate.js";
import { PragmaError, applyPragmas, readPragma } from "../../src/storage/pragmas.js";
import { freshSiloPath } from "./throwaway.js";

/**
 * The silo as the host opens it: through Prisma, pragmas asserted. All data is
 * invented, and every file is a throwaway in the OS temp directory.
 */

async function shelf(db: Awaited<ReturnType<typeof openSilo>>): Promise<string> {
  const section = await db.section.create({ data: { code: "LIF", name: "Life", order: 1 } });
  const created = await db.shelf.create({
    data: {
      sectionId: section.id,
      code: "GTH",
      name: "Gatherings",
      description: "Parties, dinners, visits.",
      order: 1,
    },
  });
  return created.id;
}

function memory(shelfId: string, seq: number) {
  const day = new Date(Date.UTC(2026, 11, 24));
  return {
    callNumber: `LIF/GTH/2026-12-24/${String(seq).padStart(3, "0")}`,
    shelfId,
    occurredOn: day,
    seq,
    kind: "episode",
    title: "Christmas at home",
    body: "Hosted Christmas with Jane Doe, John Doe and Sam Rivera.",
    trust: "stated",
    validFrom: day,
    lastConfirmedAt: new Date(Date.UTC(2026, 11, 27)),
  };
}

describe("openSilo", () => {
  it("opens a file the host just created and migrated", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "reverie-open-")), "reverie.db");
    migrateSilo(path);
    const db = await openSilo({ path });
    try {
      expect(await db.memory.count()).toBe(0);
    } finally {
      await db.$disconnect();
    }
  });

  it("sets the four pragmas and reads foreign_keys back as 1", async () => {
    const db = await openSilo({ path: freshSiloPath() });
    try {
      expect(Number(await readPragma(db, "foreign_keys"))).toBe(1);
      expect(String(await readPragma(db, "journal_mode")).toLowerCase()).toBe("wal");
      expect(Number(await readPragma(db, "synchronous"))).toBe(1);
      expect(Number(await readPragma(db, "busy_timeout"))).toBe(5000);
    } finally {
      await db.$disconnect();
    }
  });

  it("enforces the cascade through Prisma, not just through raw SQL", async () => {
    const db = await openSilo({ path: freshSiloPath() });
    try {
      const shelfId = await shelf(db);
      const created = await db.memory.create({ data: memory(shelfId, 1) });
      await db.memoryRef.create({
        data: { memoryId: created.id, role: "attendee", label: "Sam Rivera" },
      });
      await db.memory.delete({ where: { id: created.id } });
      expect(await db.memoryRef.count()).toBe(0);
    } finally {
      await db.$disconnect();
    }
  });

  it("enforces Restrict through Prisma: a shelf with memories stays", async () => {
    const db = await openSilo({ path: freshSiloPath() });
    try {
      const shelfId = await shelf(db);
      await db.memory.create({ data: memory(shelfId, 1) });
      await expect(db.shelf.delete({ where: { id: shelfId } })).rejects.toThrow();
      expect(await db.shelf.count()).toBe(1);
    } finally {
      await db.$disconnect();
    }
  });

  it("refuses an enum value the zod schema does not allow", async () => {
    const db = await openSilo({ path: freshSiloPath() });
    try {
      const shelfId = await shelf(db);
      await expect(
        db.memory.create({ data: { ...memory(shelfId, 1), kind: "rumour" } }),
      ).rejects.toThrow(/CHECK constraint failed/);
    } finally {
      await db.$disconnect();
    }
  });

  it("refuses to hand over a client when foreign keys cannot be turned on", async () => {
    // A stand-in for a connection that silently ignores the pragma.
    const deaf = {
      $executeRawUnsafe: async () => 0,
      $queryRawUnsafe: async <T>() => [{ foreign_keys: 0n }] as unknown as T,
    };
    await expect(applyPragmas(deaf)).rejects.toBeInstanceOf(PragmaError);
  });

  it("refuses a journal mode other than wal", async () => {
    const stuck = {
      $executeRawUnsafe: async () => 0,
      $queryRawUnsafe: async <T>(sql: string) =>
        (sql.includes("journal_mode") ? [{ journal_mode: "delete" }] : [{ value: 1n }]) as unknown as T,
    };
    await expect(applyPragmas(stuck)).rejects.toThrow(/journal_mode/);
  });
});

describe("checkSilo", () => {
  it("reports the pragmas, the tables, every CHECK and the search table", async () => {
    const report = await checkSilo(freshSiloPath());
    expect(Number(report.foreignKeys)).toBe(1);
    expect(String(report.journalMode).toLowerCase()).toBe("wal");
    expect(report.missingChecks).toEqual([]);
    expect(report.missingSearchTables).toEqual([]);
    expect(report.tables).toContain("Memory");
    expect(report.tables).toContain("memory_fts");
    expect(report.searchIntegrity).toEqual({ status: "ok" });
  });

  it("names what is missing on a file that was never migrated", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "reverie-empty-")), "reverie.db");
    const report = await checkSilo(path);
    expect(report.missingChecks.length).toBeGreaterThan(0);
    expect(report.missingSearchTables).toEqual(["memory_fts"]);
    expect(report.searchIntegrity).toBeNull();
  });
});
