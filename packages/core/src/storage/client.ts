import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { PrismaClient } from "../../generated/prisma/index.js";
import { dbUrl, resolveDbPath } from "./paths.js";
import { applyPragmas } from "./pragmas.js";

export type Silo = PrismaClient;

export interface OpenSiloOptions {
  /** The file to open. Defaults to the platform path, or REVERIE_DB_PATH. */
  path?: string;
  /** Create the containing directory if it is missing. On by default. */
  createDir?: boolean;
}

/**
 * Open the silo and prove the pragmas took before handing it over.
 *
 * One connection, one writer. WAL gives concurrent readers and a single writer,
 * and serializing writes through one connection is the point: it structurally
 * prevents two sessions writing to the same live file at once.
 *
 * This opens a file as it is. The host brings it up to date with migrateSilo
 * first, so a file that is not there yet is created and migrated on first run.
 */
export async function openSilo(options: OpenSiloOptions = {}): Promise<Silo> {
  const path = options.path ?? resolveDbPath();
  if (options.createDir !== false) {
    mkdirSync(dirname(path), { recursive: true });
  }

  const client = new PrismaClient({ datasourceUrl: dbUrl(path) });
  try {
    await applyPragmas(client);
  } catch (error) {
    await client.$disconnect();
    throw error;
  }
  return client;
}
