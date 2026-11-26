import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { backupHostDb, openHostDb, resolveHostDbPath } from "../src/host-db.js";
import { HostStore } from "../src/ports/host-store.js";

/** host.db: the second file, and what the host keeps in it. */

function throwaway() {
  const dir = mkdtempSync(join(tmpdir(), "reverie-hostdb-"));
  const host = openHostDb(join(dir, "host.db"));
  return { host, store: new HostStore(host), dir };
}

function tableNames(host: ReturnType<typeof openHostDb>): string[] {
  return (
    host.db.prepare(`SELECT "name" FROM sqlite_master WHERE "type" = 'table'`).all() as Array<{ name: string }>
  ).map((row) => row.name);
}

describe("host.db", () => {
  it("sits beside the silo unless told otherwise", () => {
    expect(resolveHostDbPath({ REVERIE_DB_PATH: "/tmp/reverie-x/reverie.db" })).toBe("/tmp/reverie-x/host.db");
    expect(
      resolveHostDbPath({ REVERIE_DB_PATH: "/tmp/reverie-x/reverie.db", REVERIE_HOST_DB_PATH: "/tmp/elsewhere/h.db" }),
    ).toBe("/tmp/elsewhere/h.db");
  });

  it("creates its tables and asserts the same pragmas as the silo", () => {
    const { host } = throwaway();
    try {
      const names = tableNames(host);
      for (const table of ["proposal", "proposal_claim", "audit", "setting", "value", "local_path", "event"]) {
        expect(names).toContain(table);
      }

      const journal = host.db.prepare("PRAGMA journal_mode").get() as Record<string, unknown>;
      expect(String(Object.values(journal)[0]).toLowerCase()).toBe("wal");

      const keys = host.db.prepare("PRAGMA foreign_keys").get() as Record<string, unknown>;
      expect(Number(Object.values(keys)[0])).toBe(1);

      const version = host.db.prepare("PRAGMA user_version").get() as Record<string, unknown>;
      expect(Number(Object.values(version)[0])).toBe(2);
    } finally {
      host.close();
    }
  });

  it("holds nothing from the silo", () => {
    const { host } = throwaway();
    try {
      // One file per owner: no library tables in here, ever.
      for (const table of ["Memory", "MemoryVersion", "Shelf", "Section", "Tag", "Source", "memory_fts"]) {
        expect(tableNames(host)).not.toContain(table);
      }
    } finally {
      host.close();
    }
  });

  it("round trips a proposal with its group, and decides it once", () => {
    const { host, store } = throwaway();
    try {
      const group = { id: "g1", title: "Session of 2026-12-27", detail: "two candidates", meta: { job: "extract" } };
      const { id } = store.propose({
        tool: "memory.remember",
        memoryId: null,
        payload: { body: "Prefers oat milk in coffee." },
        summary: "A fact about coffee",
        group,
      });

      const pending = store.listProposals("pending");
      expect(pending).toHaveLength(1);
      expect(pending[0]!.tool).toBe("memory.remember");
      expect(pending[0]!.payload).toEqual({ body: "Prefers oat milk in coffee." });
      expect(pending[0]!.group).toEqual(group);

      expect(store.decideProposal(id, "confirmed")).toBe(true);
      // A decided proposal is not decided twice.
      expect(store.decideProposal(id, "discarded")).toBe(false);
      expect(store.listProposals("pending")).toHaveLength(0);
      expect(store.listProposals("confirmed")).toHaveLength(1);
      expect(store.listProposals("all")).toHaveLength(1);
    } finally {
      host.close();
    }
  });

  it("appends to the audit log, ids and counts only, and never rewrites it", () => {
    const { host, store } = throwaway();
    try {
      store.logAudit({
        tool: "memory.recall",
        kind: "read",
        at: new Date("2026-12-27T10:00:00.000Z"),
        ids: { calls: ["LIF/GTH/2026-12-24/001"] },
        detail: { itemsCount: 1, sufficient: true },
      });
      store.logAudit({ tool: "memory.stats", kind: "read", at: new Date("2026-12-27T10:00:01.000Z") });

      const entries = store.listAudit();
      expect(entries).toHaveLength(2);
      expect(entries[0]!.tool).toBe("memory.stats");
      expect(entries[0]!.ids).toBeNull();
      expect(entries[1]!.ids).toEqual({ calls: ["LIF/GTH/2026-12-24/001"] });
      expect(entries[1]!.detail).toEqual({ itemsCount: 1, sufficient: true });
    } finally {
      host.close();
    }
  });

  it("keeps settings, values, project folders and events", () => {
    const { host, store } = throwaway();
    try {
      store.writeSetting("module.config", { coreTokenCap: 600 });
      expect(store.readSetting("module.config")).toEqual({ coreTokenCap: 600 });
      store.writeSetting("module.config", { coreTokenCap: 900 });
      expect(store.readSetting("module.config")).toEqual({ coreTokenCap: 900 });
      expect(store.readSetting("nothing.here")).toBeUndefined();

      expect(store.readValue("core.ownerLine")).toBeUndefined();
      store.writeValue("core.ownerLine", "Jane Doe, who keeps bees in Elmwood.");
      expect(store.readValue("core.ownerLine")).toBe("Jane Doe, who keeps bees in Elmwood.");

      store.addLocalPath("nightstash", "/work/nightstash");
      store.addLocalPath("nightstash", "/work/nightstash-wt");
      store.addLocalPath("garden", "/home/garden");
      expect(store.listLocalPaths("nightstash").map((entry) => entry.path)).toEqual([
        "/work/nightstash",
        "/work/nightstash-wt",
      ]);
      expect(store.localPathHolder("/home/garden")).toBe("garden");
      expect(store.removeLocalPath("/home/garden")).toBe(true);
      expect(store.removeLocalPath("/home/garden")).toBe(false);
      expect(store.listLocalPaths()).toHaveLength(2);

      store.recordEvent("memory.memory.written", { memoryId: "m1", call: "LIF/HOM/2026-12-27/001" });
      expect(store.listEvents()[0]).toMatchObject({
        name: "memory.memory.written",
        payload: { memoryId: "m1" },
      });
    } finally {
      host.close();
    }
  });

  it("backs itself up with VACUUM INTO rather than a file copy", () => {
    const { host, store, dir } = throwaway();
    try {
      store.writeSetting("module.config", { coreTokenCap: 500 });
      const copy = join(dir, "backup", "host.db");
      backupHostDb(host, copy);

      expect(readFileSync(copy).byteLength).toBeGreaterThan(0);
      const reopened = openHostDb(copy);
      try {
        expect(new HostStore(reopened).readSetting("module.config")).toEqual({ coreTokenCap: 500 });
      } finally {
        reopened.close();
      }
    } finally {
      host.close();
    }
  });
});
