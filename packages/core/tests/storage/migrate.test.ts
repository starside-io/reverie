import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  defaultMigrationsDir,
  migrateSilo,
  readMigrations,
} from "../../src/storage/migrate.js";

/**
 * The boot-time migrator, which is what lets the host open a file that is not
 * there yet. The rows it writes are the ones the Prisma CLI writes, so a file
 * migrated either way is the same file.
 */

function throwawayPath(): string {
  return join(mkdtempSync(join(tmpdir(), "reverie-migrate-")), "reverie.db");
}

describe("migrateSilo", () => {
  it("applies every migration to a file that does not exist yet", () => {
    const path = throwawayPath();
    const result = migrateSilo(path);

    expect(result.applied).toEqual(readMigrations().map((migration) => migration.name));
    expect(result.alreadyApplied).toEqual([]);

    const db = new DatabaseSync(path);
    try {
      const names = (
        db
          .prepare(`SELECT "name" FROM sqlite_master WHERE "type" = 'table'`)
          .all() as Array<{ name: string }>
      ).map((row) => row.name);

      for (const table of ["Section", "Shelf", "Memory", "MemorySource", "memory_fts"]) {
        expect(names).toContain(table);
      }
    } finally {
      db.close();
    }
  });

  it("is safe on every boot", () => {
    const path = throwawayPath();
    migrateSilo(path);

    const second = migrateSilo(path);
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toHaveLength(readMigrations().length);
    expect(second.changed).toEqual([]);
    expect(second.unknown).toEqual([]);
  });

  it("records what the Prisma CLI records, so the two agree", () => {
    const path = throwawayPath();
    migrateSilo(path);

    const db = new DatabaseSync(path);
    try {
      const rows = db
        .prepare(
          `SELECT "migration_name", "checksum", "applied_steps_count", "finished_at", "rolled_back_at"
           FROM "_prisma_migrations" ORDER BY "migration_name"`,
        )
        .all() as Array<Record<string, unknown>>;

      expect(rows).toHaveLength(readMigrations().length);

      for (const row of rows) {
        const name = String(row["migration_name"]);
        const sql = readFileSync(join(defaultMigrationsDir(), name, "migration.sql"));
        // Prisma stores the sha256 of the file. Anything else and the CLI
        // would report a checksum mismatch on the next deploy.
        expect(row["checksum"]).toBe(createHash("sha256").update(sql).digest("hex"));
        expect(Number(row["applied_steps_count"])).toBe(1);
        expect(row["finished_at"]).not.toBeNull();
        expect(row["rolled_back_at"]).toBeNull();
      }
    } finally {
      db.close();
    }
  });

  it("notices a migration file that changed after it was applied", () => {
    const dir = mkdtempSync(join(tmpdir(), "reverie-migrations-"));
    cpSync(defaultMigrationsDir(), dir, { recursive: true });

    const path = throwawayPath();
    migrateSilo(path, { migrationsDir: dir });

    const [first] = readMigrations(dir);
    const file = join(dir, first!.name, "migration.sql");
    writeFileSync(file, `${readFileSync(file, "utf8")}\n-- edited after the fact\n`);

    const result = migrateSilo(path, { migrationsDir: dir });
    expect(result.changed).toEqual([first!.name]);
    expect(result.applied).toEqual([]);
  });

  it("notices a file migrated by a build that knew more than this one", () => {
    const dir = mkdtempSync(join(tmpdir(), "reverie-migrations-"));
    cpSync(defaultMigrationsDir(), dir, { recursive: true });
    mkdirSync(join(dir, "29991231000000_from_the_future"), { recursive: true });
    writeFileSync(
      join(dir, "29991231000000_from_the_future", "migration.sql"),
      `CREATE TABLE "Later" ("id" TEXT PRIMARY KEY);`,
    );

    const path = throwawayPath();
    migrateSilo(path, { migrationsDir: dir });

    // This build has the migrations it shipped with, and the file has one more.
    const result = migrateSilo(path);
    expect(result.unknown).toEqual(["29991231000000_from_the_future"]);
  });
});
