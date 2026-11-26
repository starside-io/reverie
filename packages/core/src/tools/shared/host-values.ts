import type { ModuleConfig } from "../../config/index.js";
import { DAY_MS } from "../../domain/recall/score.js";
import type { HostPorts, SettingsValuesPort } from "../../ports.js";

/**
 * What core keeps in the host's settings values (SettingsPort.values): host
 * level state that is neither config nor library. docs/SPEC.md section 11
 * puts settings values in host.db, never in the silo.
 *
 *   core.ownerLine                 how the core block opens, set by the owner
 *                                  (memory.pin with ownerLine, or a `core`
 *                                  drafting proposal confirmed with decide)
 *   consolidation.lastAt           when the consolidate job last queued
 *                                  proposals (propose_draft), ISO time
 *   consolidation.sessionsSince    sessions ended since then
 *                                  (host.session.ended)
 *   sessions.readyForExtraction    session ids marked ready for extraction
 *                                  by host.session.ended, oldest first
 *   sessions.transcripts           session id to the path of its transcript,
 *                                  as the host.session.ended payload gave it:
 *                                  a pointer only, never the transcript text,
 *                                  kept for the sessions still in the list
 *                                  above
 *
 * Every reader is lenient: a missing port or a value of the wrong shape reads
 * as unset, so a hand edited row never takes a tool down.
 */

export const OWNER_LINE_KEY = "core.ownerLine";
export const CONSOLIDATION_LAST_AT_KEY = "consolidation.lastAt";
export const CONSOLIDATION_SESSIONS_KEY = "consolidation.sessionsSince";
export const READY_FOR_EXTRACTION_KEY = "sessions.readyForExtraction";
export const TRANSCRIPTS_KEY = "sessions.transcripts";

/** The longest transcript pointer kept. A path, not content. Starting value. */
export const TRANSCRIPT_POINTER_MAX_LENGTH = 4096;

/** The most characters one owner line holds. It is one line in a 40 token slot. Starting value. */
export const OWNER_LINE_MAX_LENGTH = 300;

/** The most session ids kept as ready for extraction; the oldest drop first. Starting value. */
export const READY_FOR_EXTRACTION_MAX = 200;

function valuesOf(ports: HostPorts): SettingsValuesPort | null {
  return ports.settings.values ?? null;
}

/** The owner line, or null when none is set or the host keeps no values. */
export async function readOwnerLine(ports: HostPorts): Promise<string | null> {
  const values = valuesOf(ports);
  if (!values) return null;
  const value = await values.get(OWNER_LINE_KEY);
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export interface ConsolidationState {
  /** When the consolidate job last queued proposals, or null when it never has. */
  lastAt: Date | null;
  /** Sessions ended since then. */
  sessionsSince: number;
}

export async function readConsolidation(ports: HostPorts): Promise<ConsolidationState> {
  const values = valuesOf(ports);
  if (!values) return { lastAt: null, sessionsSince: 0 };
  const [lastAt, sessions] = await Promise.all([
    values.get(CONSOLIDATION_LAST_AT_KEY),
    values.get(CONSOLIDATION_SESSIONS_KEY),
  ]);
  const at = typeof lastAt === "string" ? new Date(lastAt) : null;
  return {
    lastAt: at && !Number.isNaN(at.getTime()) ? at : null,
    sessionsSince: typeof sessions === "number" && Number.isInteger(sessions) && sessions > 0 ? sessions : 0,
  };
}

/**
 * Whether the consolidate job is due (section 17, consolidateEvery): after
 * this many sessions, or this many days since it last ran. A library that has
 * never been consolidated counts sessions only, so a new one is not due on
 * its first day. Starting reading.
 */
export function consolidationDue(
  state: ConsolidationState,
  every: ModuleConfig["consolidateEvery"],
  now: Date,
): boolean {
  if (state.sessionsSince >= every.sessions) return true;
  if (state.lastAt === null) return false;
  return now.getTime() - state.lastAt.getTime() >= every.days * DAY_MS;
}

/** Records that the consolidate job queued proposals now: the day count and the session count restart. */
export async function recordConsolidation(ports: HostPorts, now: Date): Promise<boolean> {
  const written = await transact(ports, [], () => ({
    [CONSOLIDATION_LAST_AT_KEY]: now.toISOString(),
    [CONSOLIDATION_SESSIONS_KEY]: 0,
  }));
  return written !== null;
}

/**
 * One read and write of several values that no other process interleaves
 * with, when the host can give that (SettingsValuesPort.update); a plain read
 * then write otherwise. Several MCP processes (one per session) end sessions
 * and count them over one host.db, and a read then write there loses one of
 * two appends made at the same moment. Null when the host keeps no values.
 */
async function transact(
  ports: HostPorts,
  keys: readonly string[],
  change: (current: Record<string, unknown>) => Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const values = valuesOf(ports);
  if (!values) return null;
  if (values.update) return values.update(keys, change);
  const current: Record<string, unknown> = {};
  for (const key of keys) current[key] = await values.get(key);
  const next = change(current);
  for (const [key, value] of Object.entries(next)) await values.set(key, value);
  return { ...current, ...next };
}

function sessionCount(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0;
}

function readyList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function pointerMap(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

/** A path fit to keep as a pointer, trimmed, or null. */
function usablePointer(path: string | null | undefined): string | null {
  const pointer = path?.trim() ?? "";
  return pointer.length === 0 || pointer.length > TRANSCRIPT_POINTER_MAX_LENGTH ? null : pointer;
}

/** Counts one ended session toward consolidateEvery.sessions. */
export async function countSession(ports: HostPorts): Promise<number | null> {
  let next: number | null = null;
  await transact(ports, [CONSOLIDATION_SESSIONS_KEY], (current) => {
    next = sessionCount(current[CONSOLIDATION_SESSIONS_KEY]) + 1;
    return { [CONSOLIDATION_SESSIONS_KEY]: next };
  });
  return next;
}

/** The sessions marked ready for extraction, oldest first. */
export async function readyForExtraction(ports: HostPorts): Promise<string[]> {
  const values = valuesOf(ports);
  if (!values) return [];
  return readyList(await values.get(READY_FOR_EXTRACTION_KEY));
}

/** Marks one session ready for extraction. False when it already was, or the host keeps no values. */
export async function markReadyForExtraction(ports: HostPorts, sessionId: string): Promise<boolean> {
  return (await endSession(ports, sessionId, null, { count: false })).marked;
}

/** Session id to transcript path, for the sessions marked ready for extraction. */
export async function transcriptPointers(ports: HostPorts): Promise<Record<string, string>> {
  const values = valuesOf(ports);
  if (!values) return {};
  return pointerMap(await values.get(TRANSCRIPTS_KEY));
}

/** The transcript pointer kept for one ready session, or null. */
export async function transcriptPointer(ports: HostPorts, sessionId: string): Promise<string | null> {
  return (await transcriptPointers(ports))[sessionId] ?? null;
}

/**
 * Keeps where one session's transcript is, beside its ready marker. Only the
 * path is stored; nothing here opens the file. Pointers for sessions no
 * longer in the ready list are dropped on the way. False when the pointer is
 * not a usable path or the host keeps no values.
 */
export async function setTranscriptPointer(ports: HostPorts, sessionId: string, path: string): Promise<boolean> {
  const pointer = usablePointer(path);
  if (pointer === null) return false;
  const written = await transact(ports, [READY_FOR_EXTRACTION_KEY, TRANSCRIPTS_KEY], (current) => {
    const ready = new Set(readyList(current[READY_FOR_EXTRACTION_KEY]));
    const kept = Object.fromEntries(
      Object.entries(pointerMap(current[TRANSCRIPTS_KEY])).filter(([id]) => ready.has(id) && id !== sessionId),
    );
    return { [TRANSCRIPTS_KEY]: { ...kept, [sessionId]: pointer } };
  });
  return written !== null;
}

export interface SessionEnded {
  /** False when the session was already ready, or the host keeps no values. */
  marked: boolean;
  /** The sessions counted toward consolidation since it last ran, when this one was counted. */
  sessionsSince: number | null;
  /** True when a transcript pointer was kept for it. */
  transcript: boolean;
}

/**
 * host.session.ended, as one step: the session joins the ready list (the
 * oldest drop past READY_FOR_EXTRACTION_MAX), counts once toward
 * consolidateEvery.sessions, and keeps its transcript pointer; pointers of
 * sessions no longer ready go. A session delivered twice is marked and
 * counted once, its pointer refreshed.
 */
export async function endSession(
  ports: HostPorts,
  sessionId: string,
  transcriptPath: string | null,
  options: { count?: boolean } = {},
): Promise<SessionEnded> {
  const count = options.count !== false;
  const pointer = usablePointer(transcriptPath);
  const outcome: SessionEnded = { marked: false, sessionsSince: null, transcript: false };
  await transact(ports, [READY_FOR_EXTRACTION_KEY, TRANSCRIPTS_KEY, CONSOLIDATION_SESSIONS_KEY], (current) => {
    const before = readyList(current[READY_FOR_EXTRACTION_KEY]);
    const marked = !before.includes(sessionId);
    const ready = marked ? [...before, sessionId].slice(-READY_FOR_EXTRACTION_MAX) : before;
    const keep = new Set(ready);
    const pointers = Object.fromEntries(
      Object.entries(pointerMap(current[TRANSCRIPTS_KEY])).filter(([id]) => keep.has(id)),
    );
    if (pointer !== null && keep.has(sessionId)) pointers[sessionId] = pointer;
    const patch: Record<string, unknown> = { [READY_FOR_EXTRACTION_KEY]: ready, [TRANSCRIPTS_KEY]: pointers };
    outcome.marked = marked;
    outcome.transcript = pointer !== null && keep.has(sessionId);
    outcome.sessionsSince = null;
    if (marked && count) {
      const since = sessionCount(current[CONSOLIDATION_SESSIONS_KEY]) + 1;
      patch[CONSOLIDATION_SESSIONS_KEY] = since;
      outcome.sessionsSince = since;
    }
    return patch;
  });
  return outcome;
}

/**
 * Takes one session off the ready list and drops its transcript pointer with
 * it, as one step. True when it was there: of two callers clearing the same
 * session at the same moment, exactly one gets true. Clearing a session that
 * is not ready changes nothing.
 */
export async function clearReadyForExtraction(ports: HostPorts, sessionId: string): Promise<boolean> {
  let was = false;
  await transact(ports, [READY_FOR_EXTRACTION_KEY, TRANSCRIPTS_KEY], (current) => {
    const ready = readyList(current[READY_FOR_EXTRACTION_KEY]);
    was = ready.includes(sessionId);
    if (!was) return {};
    const { [sessionId]: _dropped, ...pointers } = pointerMap(current[TRANSCRIPTS_KEY]);
    return { [READY_FOR_EXTRACTION_KEY]: ready.filter((id) => id !== sessionId), [TRANSCRIPTS_KEY]: pointers };
  });
  return was;
}
