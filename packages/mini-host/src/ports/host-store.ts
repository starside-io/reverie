import { randomUUID } from "node:crypto";

import type {
  AuditEntry,
  AuditIds,
  ListenedEventName,
  LocalPath,
  ModuleEventName,
  Proposal,
  ProposalGroup,
} from "@reverie/core";

import type { HostDb } from "../host-db.js";

/**
 * The tables the host writes on the module's behalf, and the reads the
 * standalone UI will need over them. Nothing here is in the silo. Lifted
 * from Fellowship's host-store.ts: the proposal row names a memory instead of
 * a person, the audit row carries ids instead of a person id, the connector
 * cursors are gone (the transcripts connector keeps none: core names the
 * page it wants), and the settings values and the project folder paths are
 * added.
 */

export interface ProposalRow {
  id: string;
  tool: string;
  memoryId: string | null;
  payload: unknown;
  summary: string | null;
  group: ProposalGroup | null;
  state: "pending" | "confirmed" | "discarded";
  createdAt: string;
  decidedAt: string | null;
}

export interface AuditRow {
  id: number;
  tool: string;
  kind: string;
  at: string;
  ids: AuditIds | null;
  detail: unknown;
}

export interface EventRow {
  id: number;
  name: string;
  payload: unknown;
  at: string;
}

/**
 * How long a claim on a proposal holds before another process may take it
 * over: longer than any one decision takes (the transaction timeout is a
 * minute), short enough that a process that died does not block the
 * proposal for long. Starting value.
 */
export const CLAIM_LAPSE_MS = 5 * 60_000;

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export class HostStore {
  constructor(private readonly host: HostDb) {}

  /** A write an assistant wants, waiting for the owner to confirm or discard. */
  propose(proposal: Proposal, at: Date = new Date()): { id: string } {
    const id = randomUUID();
    this.host.db
      .prepare(
        `INSERT INTO "proposal" ("id", "tool", "memoryId", "payload", "summary", "group", "state", "createdAt")
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(
        id,
        proposal.tool,
        proposal.memoryId ?? null,
        JSON.stringify(proposal.payload ?? null),
        proposal.summary ?? null,
        proposal.group ? JSON.stringify(proposal.group) : null,
        at.toISOString(),
      );
    return { id };
  }

  getProposal(id: string): ProposalRow | null {
    const row = this.host.db
      .prepare(`SELECT * FROM "proposal" WHERE "id" = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.toProposal(row) : null;
  }

  private toProposal(row: Record<string, unknown>): ProposalRow {
    return {
      id: String(row["id"]),
      tool: String(row["tool"]),
      memoryId: row["memoryId"] === null ? null : String(row["memoryId"]),
      payload: parseJson(row["payload"]),
      summary: row["summary"] === null ? null : String(row["summary"]),
      group: (row["group"] ?? null) === null ? null : (parseJson(row["group"]) as ProposalGroup | null),
      state: String(row["state"]) as ProposalRow["state"],
      createdAt: String(row["createdAt"]),
      decidedAt: row["decidedAt"] === null ? null : String(row["decidedAt"]),
    };
  }

  listProposals(state: ProposalRow["state"] | "all" = "pending"): ProposalRow[] {
    const rows =
      state === "all"
        ? (this.host.db
            .prepare(`SELECT * FROM "proposal" ORDER BY "createdAt" DESC, rowid DESC`)
            .all() as Record<string, unknown>[])
        : (this.host.db
            .prepare(
              `SELECT * FROM "proposal" WHERE "state" = ? ORDER BY "createdAt" DESC, rowid DESC`,
            )
            .all(state) as Record<string, unknown>[]);

    return rows.map((row) => this.toProposal(row));
  }

  decideProposal(
    id: string,
    state: "confirmed" | "discarded",
    at: Date = new Date(),
  ): boolean {
    const result = this.host.db
      .prepare(
        `UPDATE "proposal" SET "state" = ?, "decidedAt" = ? WHERE "id" = ? AND "state" = 'pending'`,
      )
      .run(state, at.toISOString(), id);
    // A decided proposal needs no claim: whoever held it is done with it.
    this.host.db.prepare(`DELETE FROM "proposal_claim" WHERE "id" = ?`).run(id);
    return Number(result.changes) > 0;
  }

  /**
   * Takes a pending proposal for this process to decide. Several processes
   * share this queue (one MCP server per session, a serve beside them), and
   * without a claim two of them can both read a proposal as pending and both
   * run its write. The claim is a row in proposal_claim, taken under the
   * write lock, and only while the proposal is pending; a claim older than
   * CLAIM_LAPSE_MS was left by a process that died mid decision and is taken
   * over. False when the proposal is not pending or another holder has it.
   */
  claimProposal(id: string, holder: string, at: Date = new Date()): boolean {
    return this.immediate(() => {
      const row = this.host.db.prepare(`SELECT "state" FROM "proposal" WHERE "id" = ?`).get(id) as
        | Record<string, unknown>
        | undefined;
      if (!row || row["state"] !== "pending") return false;
      const held = this.host.db
        .prepare(`SELECT "holder", "claimedAt" FROM "proposal_claim" WHERE "id" = ?`)
        .get(id) as Record<string, unknown> | undefined;
      if (held && at.getTime() - Date.parse(String(held["claimedAt"])) < CLAIM_LAPSE_MS) return false;
      this.host.db
        .prepare(
          `INSERT INTO "proposal_claim" ("id", "holder", "claimedAt") VALUES (?, ?, ?)
           ON CONFLICT ("id") DO UPDATE SET "holder" = excluded."holder", "claimedAt" = excluded."claimedAt"`,
        )
        .run(id, holder, at.toISOString());
      return true;
    });
  }

  /** Drops this holder's claim on a proposal. Someone else's is left alone. */
  releaseProposal(id: string, holder: string): void {
    this.host.db.prepare(`DELETE FROM "proposal_claim" WHERE "id" = ? AND "holder" = ?`).run(id, holder);
  }

  /**
   * Append only. Never updated, never deleted by the app. The registry has
   * already cut the entry down to ids, counts and flags; this stores what it
   * was handed and adds nothing.
   */
  logAudit(entry: AuditEntry): void {
    this.host.db
      .prepare(`INSERT INTO "audit" ("tool", "kind", "at", "ids", "detail") VALUES (?, ?, ?, ?, ?)`)
      .run(
        entry.tool,
        entry.kind,
        entry.at.toISOString(),
        entry.ids === undefined ? null : JSON.stringify(entry.ids),
        entry.detail === undefined ? null : JSON.stringify(entry.detail),
      );
  }

  listAudit(limit = 100): AuditRow[] {
    const rows = this.host.db
      .prepare(`SELECT * FROM "audit" ORDER BY "id" DESC LIMIT ?`)
      .all(limit) as Record<string, unknown>[];

    return rows.map((row) => ({
      id: Number(row["id"]),
      tool: String(row["tool"]),
      kind: String(row["kind"]),
      at: String(row["at"]),
      ids: parseJson(row["ids"]) as AuditIds | null,
      detail: parseJson(row["detail"]),
    }));
  }

  /** An event the module emitted, or one the host delivered to it. */
  recordEvent(
    name: ModuleEventName | ListenedEventName,
    payload: Record<string, unknown>,
    at: Date = new Date(),
  ): void {
    this.host.db
      .prepare(`INSERT INTO "event" ("name", "payload", "at") VALUES (?, ?, ?)`)
      .run(name, JSON.stringify(payload), at.toISOString());
  }

  listEvents(limit = 100): EventRow[] {
    const rows = this.host.db
      .prepare(`SELECT * FROM "event" ORDER BY "id" DESC LIMIT ?`)
      .all(limit) as Record<string, unknown>[];

    return rows.map((row) => ({
      id: Number(row["id"]),
      name: String(row["name"]),
      payload: parseJson(row["payload"]) as Record<string, unknown>,
      at: String(row["at"]),
    }));
  }

  readSetting(key: string): unknown {
    return this.read("setting", key);
  }

  writeSetting(key: string, value: unknown, at: Date = new Date()): void {
    this.write("setting", key, value, at);
  }

  /** A settings value (SettingsPort.values). Undefined when never set. */
  readValue(key: string): unknown {
    return this.read("value", key);
  }

  writeValue(key: string, value: unknown, at: Date = new Date()): void {
    this.write("value", key, value, at);
  }

  /**
   * Reads `keys`, hands them to `change`, writes what it returns, all under
   * one write lock, so a list two processes append to at once keeps both
   * entries (SettingsValuesPort.update). Returns the values as they stand
   * after.
   */
  updateValues(
    keys: readonly string[],
    change: (current: Record<string, unknown>) => Record<string, unknown>,
    at: Date = new Date(),
  ): Record<string, unknown> {
    return this.immediate(() => {
      const current: Record<string, unknown> = {};
      for (const key of keys) current[key] = this.read("value", key);
      const next = change(current);
      for (const [key, value] of Object.entries(next)) this.write("value", key, value, at);
      return { ...current, ...next };
    });
  }

  /**
   * Runs `work` inside BEGIN IMMEDIATE: the write lock is taken before
   * anything is read, so what is read cannot change before it is written
   * back. busy_timeout covers the wait for another process's lock.
   */
  private immediate<T>(work: () => T): T {
    this.host.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.host.db.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.host.db.isTransaction) this.host.db.exec("ROLLBACK");
      throw error;
    }
  }

  listLocalPaths(project?: string): LocalPath[] {
    const rows = (
      project === undefined
        ? this.host.db.prepare(`SELECT "project", "path" FROM "local_path" ORDER BY "project", "path"`).all()
        : this.host.db
            .prepare(`SELECT "project", "path" FROM "local_path" WHERE "project" = ? ORDER BY "path"`)
            .all(project)
    ) as Record<string, unknown>[];
    return rows.map((row) => ({ project: String(row["project"]), path: String(row["path"]) }));
  }

  /** The project that holds this folder, or null. */
  localPathHolder(path: string): string | null {
    const row = this.host.db
      .prepare(`SELECT "project" FROM "local_path" WHERE "path" = ?`)
      .get(path) as Record<string, unknown> | undefined;
    return row ? String(row["project"]) : null;
  }

  addLocalPath(project: string, path: string, at: Date = new Date()): void {
    this.host.db
      .prepare(`INSERT INTO "local_path" ("path", "project", "createdAt") VALUES (?, ?, ?)`)
      .run(path, project, at.toISOString());
  }

  removeLocalPath(path: string): boolean {
    const result = this.host.db.prepare(`DELETE FROM "local_path" WHERE "path" = ?`).run(path);
    return Number(result.changes) > 0;
  }

  private read(table: "setting" | "value", key: string): unknown {
    const row = this.host.db
      .prepare(`SELECT "value" FROM "${table}" WHERE "key" = ?`)
      .get(key) as Record<string, unknown> | undefined;
    return row ? parseJson(row["value"]) : undefined;
  }

  private write(table: "setting" | "value", key: string, value: unknown, at: Date): void {
    this.host.db
      .prepare(
        `INSERT INTO "${table}" ("key", "value", "updatedAt") VALUES (?, ?, ?)
         ON CONFLICT ("key") DO UPDATE SET "value" = excluded."value", "updatedAt" = excluded."updatedAt"`,
      )
      .run(key, JSON.stringify(value ?? null), at.toISOString());
  }
}
