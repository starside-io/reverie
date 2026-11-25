import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { openSilo, type Silo } from "../../src/storage/client.js";
import {
  BackupError,
  backupSilo,
  reindexSearch,
  searchIntegrity,
} from "../../src/storage/search-index.js";
import { freshSiloPath } from "./throwaway.js";

/**
 * memory_fts is keyed on Memory's implicit rowid, and Memory has a TEXT
 * primary key, so VACUUM is allowed to renumber the rows under the index. The
 * reproduction below builds rowid gaps, takes a VACUUM INTO copy the way
 * docs/SPEC.md section 25 says a backup is taken, and checks that every hit in
 * the copy lands on the row that holds the word. All data is invented.
 */

const WORDS = [
  "apricot", "bramble", "cobalt", "damson", "elderflower", "fennel", "gooseberry", "hazel",
  "indigo", "juniper", "kumquat", "lavender", "mulberry", "nutmeg", "oregano", "quince",
];

function tempPath(name: string): string {
  return join(mkdtempSync(join(tmpdir(), "reverie-search-")), name);
}

async function seed(db: Silo): Promise<string[]> {
  const section = await db.section.create({ data: { code: "LIF", name: "Life", order: 1 } });
  const shelf = await db.shelf.create({
    data: { sectionId: section.id, code: "GTH", name: "Gatherings", description: "Parties.", order: 1 },
  });
  const day = new Date(Date.UTC(2026, 11, 24));
  const ids: string[] = [];
  for (const [index, word] of WORDS.entries()) {
    const seq = index + 1;
    const row = await db.memory.create({
      data: {
        callNumber: `LIF/GTH/2026-12-24/${String(seq).padStart(3, "0")}`,
        shelfId: shelf.id,
        occurredOn: day,
        seq,
        kind: "episode",
        title: `Dinner ${seq}`,
        body: `Jane Doe brought a ${word} tart for Sam Rivera.`,
        trust: "stated",
        validFrom: day,
        lastConfirmedAt: day,
      },
    });
    ids.push(row.id);
  }
  // Gaps in the rowids: the case VACUUM is allowed to close up.
  for (const index of [1, 4, 5, 9, 12]) {
    await db.memory.delete({ where: { id: ids[index]! } });
  }
  return ids;
}

/** Every word still in the copy, and whether its hit is the row holding it. */
function mismatches(path: string): string[] {
  const db = new DatabaseSync(path);
  try {
    const rows = db.prepare(`SELECT "id", "body" FROM "Memory"`).all() as Array<{ id: string; body: string }>;
    const wrong: string[] = [];
    for (const word of WORDS) {
      const holder = rows.find((row) => row.body.includes(word))?.id ?? null;
      const hits = (
        db
          .prepare(
            `SELECT m."id" AS "id" FROM "memory_fts" JOIN "Memory" AS m ON m."rowid" = "memory_fts"."rowid"
              WHERE "memory_fts" MATCH ?`,
          )
          .all(word) as Array<{ id: string }>
      ).map((row) => row.id);
      const expected = holder === null ? [] : [holder];
      if (JSON.stringify(hits) !== JSON.stringify(expected)) wrong.push(word);
    }
    return wrong;
  } finally {
    db.close();
  }
}

function rowids(path: string): Array<[number, string]> {
  const db = new DatabaseSync(path);
  try {
    return (
      db.prepare(`SELECT "rowid" AS "r", "id" FROM "Memory" ORDER BY "id"`).all() as Array<{ r: number; id: string }>
    ).map((row) => [Number(row.r), row.id]);
  } finally {
    db.close();
  }
}

describe("search index drift under VACUUM INTO", () => {
  it("reproduction: a VACUUM INTO copy with rowid gaps still searches to its own rows", async () => {
    const path = freshSiloPath();
    const copy = tempPath("copy.db");
    const db = await openSilo({ path });
    try {
      await seed(db);
      await db.$executeRawUnsafe(`VACUUM INTO ?`, copy);
      expect(await searchIntegrity(db)).toEqual({ status: "ok" });
    } finally {
      await db.$disconnect();
    }

    // What this SQLite build does: the copy keeps every rowid, so the index
    // still matches. The functions below exist so a build that does renumber
    // cannot ship a drifted backup.
    expect(rowids(copy)).toEqual(rowids(path));
    expect(mismatches(copy)).toEqual([]);

    const opened = await openSilo({ path: copy, createDir: false });
    try {
      expect(await searchIntegrity(opened)).toEqual({ status: "ok" });
    } finally {
      await opened.$disconnect();
    }
  });

  it("searchIntegrity reports drift when rowids move under the index, and reindexSearch repairs it", async () => {
    const path = freshSiloPath();
    const db = await openSilo({ path });
    try {
      await seed(db);
    } finally {
      await db.$disconnect();
    }

    // Renumber the rows behind the index's back, the way a VACUUM that does
    // not preserve rowids would: no trigger runs.
    const raw = new DatabaseSync(path);
    raw.exec(`DROP TRIGGER "memory_fts_au"`);
    raw.exec(`UPDATE "Memory" SET "rowid" = "rowid" + 1000`);
    raw.exec(`CREATE TRIGGER "memory_fts_au" AFTER UPDATE ON "Memory" BEGIN
  INSERT INTO "memory_fts"("memory_fts", "rowid", "title", "body", "why", "tagText")
  VALUES ('delete', old."rowid", old."title", old."body", old."why", old."tagText");
  INSERT INTO "memory_fts"("rowid", "title", "body", "why", "tagText")
  VALUES (new."rowid", new."title", new."body", new."why", new."tagText");
END`);
    raw.close();
    expect(mismatches(path).length).toBeGreaterThan(0);

    const drifted = await openSilo({ path, createDir: false });
    try {
      const before = await searchIntegrity(drifted);
      expect(before.status).toBe("drifted");

      await reindexSearch(drifted);
      expect(await searchIntegrity(drifted)).toEqual({ status: "ok" });
    } finally {
      await drifted.$disconnect();
    }
    expect(mismatches(path)).toEqual([]);
  });
});

describe("backupSilo", () => {
  it("writes a copy, reindexes it and proves it searches to its own rows", async () => {
    const path = freshSiloPath();
    const target = tempPath("backup.db");
    const db = await openSilo({ path });
    try {
      await seed(db);
      const result = await backupSilo(db, target);
      expect(result).toEqual({ path: target, searchIntegrity: { status: "ok" } });
    } finally {
      await db.$disconnect();
    }
    expect(mismatches(target)).toEqual([]);
    expect(rowids(target)).toHaveLength(WORDS.length - 5);
  });

  it("refuses a path that already exists and leaves it alone", async () => {
    const path = freshSiloPath();
    const db = await openSilo({ path });
    try {
      await expect(backupSilo(db, path)).rejects.toBeInstanceOf(BackupError);
      expect(existsSync(path)).toBe(true);
      expect(await db.memory.count()).toBe(0);
    } finally {
      await db.$disconnect();
    }
  });
});
