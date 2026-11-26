import { createReadStream } from "node:fs";
import { lstat, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute } from "node:path";

/**
 * One Claude Code session transcript, read off disk as turns. docs/SPEC.md
 * section 12 (the `connectors` port, `transcripts`) and section 21.
 *
 * A transcript is JSON Lines. The lines that are conversation have `type`
 * `user` or `assistant`, a `message` with a `role` and a `content` that is a
 * string or a list of blocks, and usually a `timestamp`. Everything else in
 * the file (snapshots, attachments, summaries, request records) is not a
 * turn and is skipped, as is any line that does not parse.
 *
 * What a turn keeps: the text the owner typed and the text the assistant
 * wrote. What it never keeps: tool calls and their results, thinking,
 * images and other binary blocks, meta lines Claude Code adds itself, side
 * chains of subagents, and compaction summaries (a model wrote those, from
 * turns already in the file). Every size is capped, and a line too long to be
 * conversation is skipped without being held in memory whole.
 */

export type TurnRole = "user" | "assistant";

export interface TranscriptTurn {
  /** Position among the turns of this file, from 0. Stable for a given file. */
  index: number;
  role: TurnRole;
  text: string;
  /** As the line gave it, when it gave one. */
  timestamp?: string;
  /** True when the text was cut at maxTurnChars. */
  truncated?: true;
}

export interface ReadLimits {
  /** The most bytes of one file read. Past it the rest is left unread. */
  maxFileBytes: number;
  /** A line longer than this is skipped unparsed. */
  maxLineBytes: number;
  /** The most characters one turn keeps. */
  maxTurnChars: number;
}

/** Starting values. */
export const DEFAULT_LIMITS: ReadLimits = {
  maxFileBytes: 128 * 1024 * 1024,
  maxLineBytes: 2 * 1024 * 1024,
  maxTurnChars: 20_000,
};

/** The most turns one page asks for, and the most characters it holds. Starting values. */
export const PAGE_MAX_TURNS = 1000;
export const PAGE_MAX_CHARS = 200_000;

export interface PageRequest {
  /** The first turn to hand over. */
  offset: number;
  maxTurns: number;
  /** A page holds at least one turn, even when that one alone is longer. */
  maxChars: number;
}

export interface SkipCounts {
  /** Lines that did not parse as JSON. */
  malformed: number;
  /** Lines over maxLineBytes. */
  oversized: number;
  /** Lines that parsed and are not a turn: other line types, meta, side chains, summaries, tool results only. */
  other: number;
}

export interface TranscriptPage {
  turns: TranscriptTurn[];
  /** The offset of the next page, or null when this one reached the end. */
  next: number | null;
  skipped: SkipCounts;
  /** True when the file was longer than maxFileBytes and the rest was not read. */
  cut: boolean;
}

/** Why a transcript was not read. Codes only: never a path, never content. */
export type TranscriptRefusal = "no_pointer" | "not_absolute" | "not_jsonl" | "symlink" | "not_a_file" | "missing" | "bad_cursor";

export class TranscriptUnavailable extends Error {
  readonly code: TranscriptRefusal;

  constructor(code: TranscriptRefusal, message: string) {
    super(message);
    this.name = "TranscriptUnavailable";
    this.code = code;
  }
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/** A NUL anywhere means the text is not text. */
const BINARY = /\u0000/;

/** The text blocks of a message's content, joined. Everything that is not a text block is left out. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (isObject(block) && block["type"] === "text" && typeof block["text"] === "string") parts.push(block["text"]);
  }
  return parts.join("\n");
}

/**
 * One line as a turn, or why it is not one. Pure: no file, no state.
 * `malformed` when it is not JSON, `other` when it is JSON and not a turn.
 */
export function turnFromLine(line: string, maxTurnChars: number = DEFAULT_LIMITS.maxTurnChars): Omit<TranscriptTurn, "index"> | "malformed" | "other" {
  const trimmed = line.trim();
  if (trimmed.length === 0) return "other";
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return "malformed";
  }
  if (!isObject(parsed)) return "other";
  const type = parsed["type"];
  if (type !== "user" && type !== "assistant") return "other";
  if (parsed["isMeta"] === true || parsed["isSidechain"] === true || parsed["isCompactSummary"] === true) return "other";
  const message = parsed["message"];
  if (!isObject(message) || message["role"] !== type) return "other";

  const raw = textOf(message["content"]).trim();
  if (raw.length === 0 || BINARY.test(raw)) return "other";
  let text = raw;
  let truncated = false;
  if (text.length > maxTurnChars) {
    text = text.slice(0, maxTurnChars);
    // Never end on half a surrogate pair.
    const last = text.charCodeAt(text.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) text = text.slice(0, -1);
    truncated = true;
  }
  const timestamp = parsed["timestamp"];
  return {
    role: type,
    text,
    ...(typeof timestamp === "string" && timestamp.length <= 40 && !Number.isNaN(Date.parse(timestamp)) ? { timestamp } : {}),
    ...(truncated ? { truncated: true as const } : {}),
  };
}

/**
 * The file a pointer names, checked: absolute, a .jsonl file, not a symbolic
 * link, a regular file. Refuses anything else, so a pointer can only ever
 * reach a transcript, never an arbitrary file.
 */
export async function checkTranscriptPath(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new TranscriptUnavailable("not_absolute", "A transcript pointer is an absolute path.");
  if (extname(path).toLowerCase() !== ".jsonl") {
    throw new TranscriptUnavailable("not_jsonl", "A transcript pointer names a .jsonl file.");
  }
  let link;
  try {
    link = await lstat(path);
  } catch {
    throw new TranscriptUnavailable("missing", "The transcript is no longer on disk.");
  }
  if (link.isSymbolicLink()) throw new TranscriptUnavailable("symlink", "A transcript pointer may not be a symbolic link.");
  const real = await realpath(path);
  const info = await stat(real);
  if (!info.isFile()) throw new TranscriptUnavailable("not_a_file", "A transcript pointer names a regular file.");
  return real;
}

/**
 * One page of turns from a transcript file, read line by line from the start
 * and stopped as soon as the page is full. A line longer than maxLineBytes is
 * dropped as it streams past, never held whole.
 */
export async function readTranscriptPage(
  path: string,
  request: PageRequest,
  limits: ReadLimits = DEFAULT_LIMITS,
): Promise<TranscriptPage> {
  const file = await checkTranscriptPath(path);
  const offset = Math.max(0, Math.floor(request.offset));
  const maxTurns = Math.min(Math.max(1, Math.floor(request.maxTurns)), PAGE_MAX_TURNS);
  const maxChars = Math.min(Math.max(1, Math.floor(request.maxChars)), PAGE_MAX_CHARS);

  const skipped: SkipCounts = { malformed: 0, oversized: 0, other: 0 };
  const turns: TranscriptTurn[] = [];
  let chars = 0;
  let index = 0;
  let more = false;
  let cut = false;

  const stream = createReadStream(file, { start: 0, end: limits.maxFileBytes - 1 });
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let dropping = false;
  let done = false;

  const take = (line: string): void => {
    const turn = turnFromLine(line, limits.maxTurnChars);
    if (turn === "malformed") {
      skipped.malformed += 1;
      return;
    }
    if (turn === "other") {
      skipped.other += 1;
      return;
    }
    const at = index;
    index += 1;
    if (at < offset) return;
    const full = turns.length >= maxTurns || (turns.length > 0 && chars + turn.text.length > maxChars);
    if (full) {
      more = true;
      done = true;
      return;
    }
    turns.push({ index: at, ...turn });
    chars += turn.text.length;
  };

  const endLine = (): void => {
    if (!dropping && pendingBytes > 0) take(Buffer.concat(pending, pendingBytes).toString("utf8"));
    pending = [];
    pendingBytes = 0;
    dropping = false;
  };

  let bytesRead = 0;
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      bytesRead += chunk.length;
      let start = 0;
      for (;;) {
        const newline = chunk.indexOf(0x0a, start);
        const end = newline === -1 ? chunk.length : newline;
        if (!dropping) {
          const piece = chunk.subarray(start, end);
          if (pendingBytes + piece.length > limits.maxLineBytes) {
            dropping = true;
            skipped.oversized += 1;
            pending = [];
            pendingBytes = 0;
          } else if (piece.length > 0) {
            pending.push(Buffer.from(piece));
            pendingBytes += piece.length;
          }
        }
        if (newline === -1) break;
        endLine();
        if (done) break;
        start = newline + 1;
      }
      if (done) break;
    }
    if (!done) endLine();
  } finally {
    stream.destroy();
  }
  if (!done && bytesRead >= limits.maxFileBytes) cut = true;

  return { turns, next: more ? offset + turns.length : null, skipped, cut };
}
