import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startMiniHost, type MiniHost } from "@reverie/mini-host";

import { createMemoryToolHandler, type MemoryToolCallOptions, type MemoryToolHandler, type MemoryToolResult } from "../src/index.js";

/**
 * A throwaway silo and host.db, migrated and seeded by the host on the way
 * up. Never the real one. Every name in these tests is invented.
 */
export interface Rig {
  host: MiniHost;
  handle: MemoryToolHandler;
  /** One command, as the model would send it. */
  call(input: Record<string, unknown>, options?: MemoryToolCallOptions): Promise<MemoryToolResult>;
  close(): Promise<void>;
}

export const NOW = new Date("2026-12-27T10:00:00Z");

export async function rig(): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), "reverie-memtool-"));
  const env = { ...process.env, REVERIE_DB_PATH: join(dir, "reverie.db"), REVERIE_HOST_DB_PATH: join(dir, "host.db") };
  const host = await startMiniHost({
    dbPath: join(dir, "reverie.db"),
    hostDbPath: join(dir, "host.db"),
    env,
    transcripts: false,
  });
  const handle = createMemoryToolHandler(host.api, { now: NOW });
  return {
    host,
    handle,
    call: (input, options) => handle(input, options),
    close: async () => {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A memory the owner told the library directly, through the registry. */
export async function remember(host: MiniHost, input: Record<string, unknown>): Promise<{ id: string; call: string }> {
  const result = (await host.api.invoke("memory.remember", { kind: "fact", ...input }, { now: NOW })) as {
    memory: { id: string; call: string };
  };
  return result.memory;
}
