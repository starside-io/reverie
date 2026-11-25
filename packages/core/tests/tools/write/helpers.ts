import { history, type VersionRow } from "../../../src/domain/versions.js";
import type { RememberResult } from "../../../src/tools/write/remember.js";
import type { TestHost } from "../../test-host.js";

/**
 * Small helpers the write tool tests share. Every name is invented and every
 * silo is a throwaway one.
 */

export const NOW = new Date("2026-12-27T10:00:00.000Z");

export function remember(host: TestHost, input: Record<string, unknown>): Promise<RememberResult> {
  return host.invoke<RememberResult>("memory.remember", { kind: "fact", ...input });
}

/** A Christmas episode on LIF/GTH, the usual fixture. */
export function christmas(host: TestHost, overrides: Record<string, unknown> = {}): Promise<RememberResult> {
  return remember(host, {
    kind: "episode",
    shelf: "LIF/GTH",
    occurredOn: "2026-12-24",
    title: "Christmas at home",
    body: "Hosted Christmas. The oven died mid afternoon, so we ordered pizza.",
    ...overrides,
  });
}

export function versions(host: TestHost, memoryId: string): Promise<VersionRow[]> {
  return history(host.db, memoryId);
}

/** Every row of every table in the silo, as one JSON text: for asserting what never lands there. */
export async function siloText(host: TestHost): Promise<string> {
  const tables = await host.db.$queryRawUnsafe<Array<{ name: string }>>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
  );
  const dump: Record<string, unknown[]> = {};
  for (const { name } of tables) {
    dump[name] = await host.db.$queryRawUnsafe<unknown[]>(`SELECT * FROM "${name.replace(/"/g, '""')}"`);
  }
  return JSON.stringify(dump, (_key, value) => (typeof value === "bigint" ? value.toString() : value));
}
