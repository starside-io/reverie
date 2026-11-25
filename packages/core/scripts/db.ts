/**
 * The database CLI for the silo.
 *
 *   pnpm db:path       print the file this machine uses
 *   pnpm db:generate   generate the Prisma client
 *   pnpm db:migrate    apply pending migrations to that file
 *   pnpm db:new <name> write a new migration from the schema, checks injected
 *   pnpm db:check      open the file and prove the pragmas took
 *
 * Migrations are written with `migrate diff` and applied with `migrate deploy`
 * rather than with `migrate dev`, because the enum CHECK constraints and the
 * FTS5 virtual table are raw SQL that no Prisma schema can express. `migrate
 * dev` would see them as drift and offer to reset the file, and the file holds
 * real personal data.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { injectEnumChecks } from "../src/storage/enum-checks.js";
import { stripSearchDrops } from "../src/storage/search-sql.js";
import { DB_URL_ENV, dbUrl, resolveDbPath } from "../src/storage/paths.js";

const here = dirname(fileURLToPath(import.meta.url));
const coreRoot = join(here, "..");
const schemaPath = join(coreRoot, "src", "storage", "schema.prisma");
const migrationsPath = join(coreRoot, "src", "storage", "migrations");

const command = process.argv[2] ?? "";
const argument = process.argv[3];

function prisma(args: string[], env: Record<string, string> = {}): void {
  const result = spawnSync("prisma", args, {
    cwd: coreRoot,
    stdio: "inherit",
    env: { ...process.env, [DB_URL_ENV]: dbUrl(), ...env },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function prismaOutput(args: string[]): string {
  const result = spawnSync("prisma", args, {
    cwd: coreRoot,
    encoding: "utf8",
    env: { ...process.env, [DB_URL_ENV]: dbUrl() },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? "");
    process.exit(result.status ?? 1);
  }
  return result.stdout ?? "";
}

function stamp(): string {
  const iso = new Date().toISOString();
  return iso.replace(/[-:T]/g, "").slice(0, 14);
}

switch (command) {
  case "path": {
    process.stdout.write(`${resolveDbPath()}\n`);
    break;
  }

  case "generate": {
    prisma(["generate"]);
    break;
  }

  case "migrate": {
    // The directory has to exist before SQLite will create the file in it.
    mkdirSync(dirname(resolveDbPath()), { recursive: true });
    prisma(["migrate", "deploy"]);
    break;
  }

  case "new": {
    if (!argument) {
      process.stderr.write("Usage: db.ts new <migration-name>\n");
      process.exit(2);
    }
    const shadow = join(mkdtempSync(join(tmpdir(), "reverie-shadow-")), "shadow.db");
    const sql = prismaOutput([
      "migrate",
      "diff",
      "--from-migrations",
      migrationsPath,
      "--to-schema-datamodel",
      schemaPath,
      "--shadow-database-url",
      `file:${shadow}`,
      "--script",
    ]);

    const body = sql.trim();
    if (body.length === 0 || body === "-- This is an empty migration.") {
      process.stdout.write("No schema changes. Nothing written.\n");
      break;
    }

    // Prisma cannot model a virtual table, so every diff asks to drop the
    // whole search layer. Those statements are removed here rather than left
    // for a human to notice in a 60 line migration at the wrong moment.
    const { sql: migration, removed } = stripSearchDrops(body);
    // The search drops alone are not a change.
    if (migration.trim().length === 0) {
      process.stdout.write("No schema changes. Nothing written.\n");
      break;
    }

    const dir = join(migrationsPath, `${stamp()}_${argument}`);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "migration.sql");
    writeFileSync(file, `${injectEnumChecks(migration)}\n`);
    process.stdout.write(`Wrote ${file}\n`);
    if (removed.length > 0) {
      process.stdout.write(
        `Left the search layer alone: dropped ${removed.length} DROP TABLE statements for ${removed
          .slice(0, 3)
          .join(", ")}${removed.length > 3 ? ", and the rest" : ""}.\n`,
      );
    }
    break;
  }

  case "check": {
    const { checkSilo } = await import("../src/storage/check.js");
    const report = await checkSilo();
    process.stdout.write(`file           ${report.path}\n`);
    process.stdout.write(`foreign_keys   ${String(report.foreignKeys)}\n`);
    process.stdout.write(`journal_mode   ${String(report.journalMode)}\n`);
    process.stdout.write(`synchronous    ${String(report.synchronous)}\n`);
    process.stdout.write(`busy_timeout   ${String(report.busyTimeout)}\n`);
    process.stdout.write(`tables         ${String(report.tables.length)}\n`);
    if (report.missingChecks.length > 0) {
      process.stderr.write(`Missing CHECK constraints: ${report.missingChecks.join(", ")}\n`);
      process.exit(1);
    }
    process.stdout.write("checks         all present\n");
    if (report.missingSearchTables.length > 0) {
      process.stderr.write(`Missing search tables: ${report.missingSearchTables.join(", ")}\n`);
      process.exit(1);
    }
    process.stdout.write("search         all present\n");
    if (report.searchIntegrity?.status !== "ok") {
      process.stderr.write(
        `Search index drifted: ${report.searchIntegrity?.detail ?? "not checked"}. Rebuild it with reindexSearch.\n`,
      );
      process.exit(1);
    }
    process.stdout.write("search index   ok\n");
    break;
  }

  default: {
    process.stderr.write("Usage: db.ts path | generate | migrate | new <name> | check\n");
    process.exit(2);
  }
}
