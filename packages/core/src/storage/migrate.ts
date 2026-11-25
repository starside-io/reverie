import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Applying the migrations without the Prisma CLI, so the host can open a file
 * that is not there yet.
 *
 * The rows written here are the ones `prisma migrate deploy` writes: the same
 * table, the same columns, and the checksum is the sha256 of the migration
 * file, which is what Prisma compares against. A file migrated by the host and
 * a file migrated by the CLI are therefore the same file, and
 * `prisma migrate status` agrees with both.
 *
 * The CLI stays the way new migrations are written. This only applies what is
 * already in the directory.
 */

const MIGRATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
    "id"                    TEXT PRIMARY KEY NOT NULL,
    "checksum"              TEXT NOT NULL,
    "finished_at"           DATETIME,
    "migration_name"        TEXT NOT NULL,
    "logs"                  TEXT,
    "rolled_back_at"        DATETIME,
    "started_at"            DATETIME NOT NULL DEFAULT current_timestamp,
    "applied_steps_count"   INTEGER UNSIGNED NOT NULL DEFAULT 0
)`;

/** Where the migrations live, next to the schema they were generated from. */
export function defaultMigrationsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "migrations");
}

export interface Migration {
  name: string;
  sql: string;
  checksum: string;
}

export function readMigrations(dir: string = defaultMigrationsDir()): Migration[] {
  if (!existsSync(dir)) {
    throw new Error(
      `No migrations at ${dir}. A build carries them beside the compiled storage module: see scripts/copy-sql.mjs.`,
    );
  }

  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name) => {
      const sql = readFileSync(join(dir, name, "migration.sql"), "utf8");
      return {
        name,
        sql,
        checksum: createHash("sha256").update(sql).digest("hex"),
      };
    });
}

export interface MigrateResult {
  applied: string[];
  alreadyApplied: string[];
  /** Names in the file that this build does not have a migration for. */
  unknown: string[];
  /** Names whose file changed since it was applied. */
  changed: string[];
}

/**
 * Brings one file up to date. Safe to call on every boot: a file that is
 * already current comes back with nothing applied.
 */
export function migrateSilo(
  path: string,
  options: { migrationsDir?: string } = {},
): MigrateResult {
  mkdirSync(dirname(path), { recursive: true });

  const migrations = readMigrations(options.migrationsDir ?? defaultMigrationsDir());
  const db = new DatabaseSync(path);

  try {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = 5000");
    // Off while the schema is built: the statements create tables that
    // reference tables created further down the same script.
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec(MIGRATIONS_TABLE);

    const recorded = new Map(
      (
        db
          .prepare(`SELECT "migration_name", "checksum" FROM "_prisma_migrations"`)
          .all() as Array<Record<string, unknown>>
      ).map((row) => [String(row["migration_name"]), String(row["checksum"])]),
    );

    const result: MigrateResult = {
      applied: [],
      alreadyApplied: [],
      unknown: [],
      changed: [],
    };

    for (const migration of migrations) {
      const seen = recorded.get(migration.name);
      if (seen !== undefined) {
        result.alreadyApplied.push(migration.name);
        if (seen !== migration.checksum) result.changed.push(migration.name);
        continue;
      }

      const startedAt = new Date().toISOString();
      db.exec("BEGIN");
      try {
        db.exec(migration.sql);
        db.prepare(
          `INSERT INTO "_prisma_migrations"
             ("id", "checksum", "finished_at", "migration_name", "logs", "rolled_back_at", "started_at", "applied_steps_count")
           VALUES (?, ?, ?, ?, NULL, NULL, ?, 1)`,
        ).run(
          randomUUID(),
          migration.checksum,
          new Date().toISOString(),
          migration.name,
          startedAt,
        );
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw new Error(
          `Migration "${migration.name}" failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      result.applied.push(migration.name);
    }

    const known = new Set(migrations.map((migration) => migration.name));
    for (const name of recorded.keys()) {
      if (!known.has(name)) result.unknown.push(name);
    }

    return result;
  } finally {
    db.close();
  }
}
