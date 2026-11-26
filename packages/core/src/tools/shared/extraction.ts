import type { Material, TurnRole } from "../../domain/drafting/gates.js";
import { liveSessionNotes } from "../../domain/session-notes.js";
import { dayKey } from "../../schemas/common.js";
import { ToolError, type ToolContext } from "../registry.js";
import { readyForExtraction, transcriptPointers } from "./host-values.js";

/**
 * The extraction read path: what a finished session left behind, handed to
 * the extract job. docs/SPEC.md section 13 (capture, then extract: "turns,
 * rules, schema"), section 15 (memory.session_note is "input to
 * extraction"), section 18 (host.session.ended marks the session ready),
 * section 19 (SessionEnd leaves "a pointer to its transcript").
 *
 * A finished session's material is its live session notes and, when the
 * host has the `transcripts` connector, the turns of its transcript, read
 * through the `connectors` port by session id. Core never opens a file: the
 * host's connector reads the one path the SessionEnd hook stored for that
 * session and nothing else. The material is never stored anywhere: not in the
 * audit line, not in an event, not in host.db. Only ids, counts and the fact
 * that a pointer exists travel.
 *
 * A long transcript comes in pages, each within EXTRACT_PAGE_MAX_CHARS, so
 * one call never floods the drafter's context. The page is named by the turn
 * it starts at (`cursor`); propose_draft reads the same page again to check
 * every quote against exactly what the drafter was handed.
 */

/** The most transcript characters one page hands over, notes aside. Starting value. */
export const EXTRACT_PAGE_MAX_CHARS = 60_000;
/** The most transcript turns one page hands over. Starting value. */
export const EXTRACT_PAGE_MAX_TURNS = 400;
/** The most session notes handed over, and their characters together. They ride on the first page. Starting values. */
export const EXTRACT_NOTES_MAX = 100;
export const EXTRACT_NOTES_MAX_CHARS = 40_000;

/** The connector this path reads, as module.json names it. */
export const TRANSCRIPTS_CONNECTOR = "transcripts";

/**
 * What became of the transcript for one page: `read`, or why not. A refusal
 * from the connector is passed on by its code only, never its message.
 */
export type TranscriptStatus = "read" | "no_connector" | "no_pointer" | "unavailable";

export interface ReadySession {
  session: string;
  /** Live session notes held for it. */
  notes: number;
  /** True when its SessionEnd hook left a transcript pointer. */
  transcript: boolean;
}

export interface SessionPage {
  session: string;
  material: Material;
  /** Notes handed over on this page (the first only), and those left out over the cap. */
  notes: number;
  notesLeftOut: number;
  turns: number;
  characters: number;
  transcript: TranscriptStatus;
  /** The connector's refusal code when the transcript was unavailable. */
  transcriptReason: string | null;
  /** The turn this page starts at, and the one the next page starts at, or null at the end. */
  cursor: number;
  next: number | null;
  sessionDate: string;
}

/** Every finished session waiting for extraction, oldest first, with what each holds. */
export async function readySessions(ctx: ToolContext): Promise<ReadySession[]> {
  const [ready, pointers] = await Promise.all([readyForExtraction(ctx.ports), transcriptPointers(ctx.ports)]);
  const out: ReadySession[] = [];
  for (const session of ready) {
    const notes = await ctx.db.sessionNote.count({ where: { sessionId: session, expiresAt: { gt: ctx.now } } });
    out.push({ session, notes, transcript: typeof pointers[session] === "string" });
  }
  return out;
}

/** Refuses a session that is not waiting for extraction: nothing else is read. */
export async function requireReady(ctx: ToolContext, session: string): Promise<void> {
  if ((await readyForExtraction(ctx.ports)).includes(session)) return;
  throw new ToolError(
    "not_found",
    "No finished session by that id is waiting for extraction. memory_draft_context with job extract and no session lists the ones that are.",
    { session },
  );
}

/** The refusal while incognito is on: no capture runs (section 7). */
export function incognitoCapture(): ToolError {
  return new ToolError(
    "refused",
    "Incognito is on, so no capture runs: a finished session's notes and transcript are not read. The owner turns incognito off in settings to extract again.",
    { incognito: true },
  );
}

function refusalCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[a-z_]{1,40}$/.test(code) ? code : "failed";
}

interface PulledTurn {
  role: "user" | "assistant";
  text: string;
  at?: string;
}

function turnOf(payload: unknown): PulledTurn | null {
  if (!payload || typeof payload !== "object") return null;
  const value = payload as { role?: unknown; text?: unknown; timestamp?: unknown };
  if (value.role !== "user" && value.role !== "assistant") return null;
  if (typeof value.text !== "string" || value.text.trim().length === 0) return null;
  return {
    role: value.role,
    text: value.text,
    ...(typeof value.timestamp === "string" && value.timestamp.length <= 40 ? { at: value.timestamp } : {}),
  };
}

/**
 * One page of a finished session's material: on the first page its live
 * notes, then as many transcript turns as fit. Without a connector, or with
 * no pointer, the notes alone, and `transcript` says why.
 */
export async function readSessionPage(
  ctx: ToolContext,
  session: string,
  cursor: number,
  sessionDate: string | undefined,
): Promise<SessionPage> {
  const turns: Array<{ role: TurnRole; text: string; at?: string }> = [];
  const days: string[] = [];

  let notes = 0;
  let notesLeftOut = 0;
  let noteChars = 0;
  if (cursor === 0) {
    const live = await liveSessionNotes(ctx.db, session, ctx.now);
    for (const note of live) {
      if (notes >= EXTRACT_NOTES_MAX || noteChars + note.body.length > EXTRACT_NOTES_MAX_CHARS) {
        notesLeftOut += 1;
        continue;
      }
      turns.push({ role: "note", text: note.body, at: note.createdAt.toISOString() });
      days.push(dayKey(note.createdAt));
      notes += 1;
      noteChars += note.body.length;
    }
  }

  let transcript: TranscriptStatus = "no_connector";
  let transcriptReason: string | null = null;
  let next: number | null = null;
  let turnCount = 0;
  let turnChars = 0;
  const connectors = ctx.ports.connectors;
  if (connectors) {
    try {
      // The cursor names the session, never a path: the host's connector
      // looks up the one pointer stored for it.
      const pulled = await connectors.pull(
        TRANSCRIPTS_CONNECTOR,
        JSON.stringify({ session, offset: cursor, maxTurns: EXTRACT_PAGE_MAX_TURNS, maxChars: EXTRACT_PAGE_MAX_CHARS }),
      );
      for (const item of pulled.items.slice(0, EXTRACT_PAGE_MAX_TURNS)) {
        const turn = turnOf(item.payload);
        if (!turn) continue;
        turns.push(turn);
        turnCount += 1;
        turnChars += turn.text.length;
        if (turn.at && !Number.isNaN(Date.parse(turn.at))) days.push(dayKey(new Date(turn.at)));
      }
      transcript = "read";
      next = pulled.cursor ? cursor + pulled.items.length : null;
    } catch (error) {
      const code = refusalCode(error);
      transcript = code === "no_pointer" ? "no_pointer" : "unavailable";
      transcriptReason = code;
    }
  }

  return {
    session,
    material: { kind: "turns", turns },
    notes,
    notesLeftOut,
    turns: turnCount,
    characters: noteChars + turnChars,
    transcript,
    transcriptReason,
    cursor,
    next,
    sessionDate: sessionDate ?? ([...days].sort()[0] ?? dayKey(ctx.now)),
  };
}

/** One line on what a page holds, for the drafter and the owner. */
export function pageNotice(page: SessionPage): string {
  const parts = [`${page.notes} session ${page.notes === 1 ? "note" : "notes"}`];
  if (page.notesLeftOut > 0) parts.push(`${page.notesLeftOut} more left out over the cap`);
  switch (page.transcript) {
    case "read":
      parts.push(`${page.turns} transcript ${page.turns === 1 ? "turn" : "turns"} from turn ${page.cursor}`);
      break;
    case "no_connector":
      parts.push("no transcript: this host has no transcripts connector, so these are the notes alone");
      break;
    case "no_pointer":
      parts.push("no transcript: the session ended without a transcript pointer, so these are the notes alone");
      break;
    case "unavailable":
      parts.push(`no transcript: it could not be read (${page.transcriptReason}), so these are the notes alone`);
      break;
  }
  if (page.next !== null) parts.push(`more turns follow: pass the continuation target to read them`);
  return `${parts.join("; ")}.`;
}
