import { DEFAULT_LIMITS, readTranscriptPage, TranscriptUnavailable, type ReadLimits, type TranscriptTurn } from "./read.js";

export * from "./read.js";

/**
 * The `transcripts` connector. docs/SPEC.md section 12: the optional
 * `connectors` port hands over session transcripts off disk as turns. It
 * plugs into the host, never into core: core asks the port for a session's
 * turns and never touches the filesystem itself.
 *
 * The shape it answers is the port's: `pull(cursor)` gives items and the
 * cursor of the next page. This package declares that shape itself rather
 * than importing it, so it depends on nothing of core's.
 *
 * What it will read is decided by the host, not by the caller: the cursor
 * names a session id, and the host's `pointerFor` gives the one path stored
 * for that session when its SessionEnd hook ran. A session with no stored
 * pointer reads nothing. There is no way to hand it a path.
 */

export const CONNECTOR_NAME = "transcripts";

/** One turn as the port carries it. */
export interface TurnItem {
  id: string;
  payload: { role: TranscriptTurn["role"]; text: string; timestamp?: string; truncated?: true };
}

export interface TranscriptPull {
  items: TurnItem[];
  /** The cursor of the next page, or null at the end. */
  cursor: string | null;
}

/** What a cursor carries. Core writes it; nothing in it is a path. */
export interface TranscriptCursor {
  session: string;
  offset?: number;
  maxTurns?: number;
  maxChars?: number;
}

export interface TranscriptsConnectorOptions {
  /** The transcript path stored for this session, or null. The only path ever read. */
  pointerFor(sessionId: string): string | null | Promise<string | null>;
  limits?: ReadLimits;
}

export interface TranscriptsConnector {
  readonly name: typeof CONNECTOR_NAME;
  pull(cursor?: string | null): Promise<TranscriptPull>;
}

/** Starting values for a page when the cursor names none. */
export const DEFAULT_PAGE = { maxTurns: 400, maxChars: 60_000 } as const;

export function parseCursor(cursor: string | null | undefined): Required<TranscriptCursor> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(cursor ?? "");
  } catch {
    throw new TranscriptUnavailable("bad_cursor", "A transcripts cursor is JSON naming a session.");
  }
  const value = parsed as Partial<TranscriptCursor> | null;
  if (!value || typeof value !== "object" || typeof value.session !== "string" || value.session.trim().length === 0) {
    throw new TranscriptUnavailable("bad_cursor", "A transcripts cursor is JSON naming a session.");
  }
  const whole = (n: unknown, fallback: number) => (typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : fallback);
  return {
    session: value.session.trim(),
    offset: whole(value.offset, 0),
    maxTurns: whole(value.maxTurns, DEFAULT_PAGE.maxTurns) || DEFAULT_PAGE.maxTurns,
    maxChars: whole(value.maxChars, DEFAULT_PAGE.maxChars) || DEFAULT_PAGE.maxChars,
  };
}

export function createTranscriptsConnector(options: TranscriptsConnectorOptions): TranscriptsConnector {
  const limits = options.limits ?? DEFAULT_LIMITS;
  return {
    name: CONNECTOR_NAME,
    async pull(cursor) {
      const request = parseCursor(cursor);
      const pointer = await options.pointerFor(request.session);
      if (!pointer) {
        throw new TranscriptUnavailable("no_pointer", "No transcript is stored for that session.");
      }
      const page = await readTranscriptPage(pointer, request, limits);
      return {
        items: page.turns.map((turn) => ({
          id: `turn:${turn.index}`,
          payload: {
            role: turn.role,
            text: turn.text,
            ...(turn.timestamp ? { timestamp: turn.timestamp } : {}),
            ...(turn.truncated ? { truncated: true as const } : {}),
          },
        })),
        cursor: page.next === null ? null : JSON.stringify({ ...request, offset: page.next }),
      };
    },
  };
}
