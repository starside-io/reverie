import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "src",
  "storage",
  "migrations",
);

/** Every migration, in the order `migrate deploy` would apply them. */
export function migrationFiles(): string[] {
  return readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name) => join(migrationsDir, name, "migration.sql"));
}

/**
 * A fresh silo in a temp directory, built by applying the real migrations.
 * Never point a test at the live file: it holds real memories.
 */
export function throwawaySilo(): { db: DatabaseSync; path: string } {
  const path = join(mkdtempSync(join(tmpdir(), "reverie-test-")), "reverie.db");
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  for (const file of migrationFiles()) {
    db.exec(readFileSync(file, "utf8"));
  }
  return { db, path };
}

/** A migrated silo, closed again, for a test that opens it through Prisma. */
export function freshSiloPath(): string {
  const silo = throwawaySilo();
  silo.db.close();
  return silo.path;
}
