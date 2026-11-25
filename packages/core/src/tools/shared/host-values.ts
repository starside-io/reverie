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
  const values = valuesOf(ports);
  if (!values) return false;
  await values.set(CONSOLIDATION_LAST_AT_KEY, now.toISOString());
  await values.set(CONSOLIDATION_SESSIONS_KEY, 0);
  return true;
}

/** Counts one ended session toward consolidateEvery.sessions. */
export async function countSession(ports: HostPorts): Promise<number | null> {
  const values = valuesOf(ports);
  if (!values) return null;
  const { sessionsSince } = await readConsolidation(ports);
  const next = sessionsSince + 1;
  await values.set(CONSOLIDATION_SESSIONS_KEY, next);
  return next;
}

/** The sessions marked ready for extraction, oldest first. */
export async function readyForExtraction(ports: HostPorts): Promise<string[]> {
  const values = valuesOf(ports);
  if (!values) return [];
  const value = await values.get(READY_FOR_EXTRACTION_KEY);
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/** Marks one session ready for extraction. False when it already was, or the host keeps no values. */
export async function markReadyForExtraction(ports: HostPorts, sessionId: string): Promise<boolean> {
  const values = valuesOf(ports);
  if (!values) return false;
  const ready = await readyForExtraction(ports);
  if (ready.includes(sessionId)) return false;
  await values.set(READY_FOR_EXTRACTION_KEY, [...ready, sessionId].slice(-READY_FOR_EXTRACTION_MAX));
  return true;
}

/** Session id to transcript path, for the sessions marked ready for extraction. */
export async function transcriptPointers(ports: HostPorts): Promise<Record<string, string>> {
  const values = valuesOf(ports);
  if (!values) return {};
  const value = await values.get(TRANSCRIPTS_KEY);
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

/**
 * Keeps where one session's transcript is, beside its ready marker. Only the
 * path is stored; nothing here opens the file. Pointers for sessions no
 * longer in the ready list are dropped on the way. False when the pointer is
 * not a usable path or the host keeps no values.
 */
export async function setTranscriptPointer(ports: HostPorts, sessionId: string, path: string): Promise<boolean> {
  const values = valuesOf(ports);
  if (!values) return false;
  const pointer = path.trim();
  if (pointer.length === 0 || pointer.length > TRANSCRIPT_POINTER_MAX_LENGTH) return false;
  const ready = new Set(await readyForExtraction(ports));
  const kept = Object.fromEntries(
    Object.entries(await transcriptPointers(ports)).filter(([id]) => ready.has(id) && id !== sessionId),
  );
  await values.set(TRANSCRIPTS_KEY, { ...kept, [sessionId]: pointer });
  return true;
}
