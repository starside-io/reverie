import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ModelsPort } from "@reverie/core";

import { startMiniHost, type MiniHost } from "../src/host.js";

/**
 * A throwaway pair of files, migrated and seeded on the way up by the host
 * itself. Never point a test at the real silo: it holds real memories. Every
 * name in these tests is invented (Jane Doe, John Doe, Sam Rivera).
 */

export function throwawayDir(): string {
  return mkdtempSync(join(tmpdir(), "reverie-host-"));
}

export function filesIn(dir: string): { dbPath: string; hostDbPath: string } {
  return { dbPath: join(dir, "reverie.db"), hostDbPath: join(dir, "host.db") };
}

/** The env a child process gets: both files in the given directory. */
export function envFor(dir: string): NodeJS.ProcessEnv {
  const files = filesIn(dir);
  return { ...process.env, REVERIE_DB_PATH: files.dbPath, REVERIE_HOST_DB_PATH: files.hostDbPath };
}

export async function throwawayHost(options: { models?: ModelsPort; dir?: string } = {}): Promise<MiniHost> {
  const dir = options.dir ?? throwawayDir();
  return startMiniHost({
    ...filesIn(dir),
    env: envFor(dir),
    ...(options.models ? { models: options.models } : {}),
  });
}

export interface Remembered {
  memory: { id: string; call: string; title: string };
}

export async function remember(host: MiniHost, input: Record<string, unknown>): Promise<Remembered> {
  return (await host.api.invoke("memory.remember", { kind: "fact", ...input })) as Remembered;
}

/** Every string in a value, at any depth. */
export function stringsIn(value: unknown): string[] {
  const out: string[] = [];
  const walk = (item: unknown) => {
    if (typeof item === "string") out.push(item);
    else if (Array.isArray(item)) item.forEach(walk);
    else if (item && typeof item === "object") Object.values(item).forEach(walk);
  };
  walk(value);
  return out;
}

/** The audit table of host.db, every column of every row, as one text. */
export function auditText(host: MiniHost): string {
  return JSON.stringify(host.host.db.prepare(`SELECT * FROM "audit"`).all());
}
