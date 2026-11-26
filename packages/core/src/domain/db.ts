import type { Prisma } from "../../generated/prisma/index.js";
import type { Silo } from "../storage/client.js";

/** A client inside an interactive transaction. */
export type Tx = Prisma.TransactionClient;

/** Either the silo itself or a transaction already open on it. */
export type Db = Silo | Tx;

/**
 * Long enough for a shelf merge that reshelves a few thousand entries. The
 * silo has one writer, so holding it this long blocks nobody but the caller.
 * Starting value.
 */
export const TRANSACTION_TIMEOUT_MS = 60_000;

/**
 * How long a transaction waits for this process's one connection while
 * another call in the same process holds it (Prisma's maxWait, 2 seconds by
 * default). An MCP client may send parallel tool calls to one server, and a
 * serve answers parallel requests. Starting value.
 */
export const TRANSACTION_MAX_WAIT_MS = 15_000;

/**
 * How many times a transaction that found the file busy is run again, and
 * the first pause before it is. The pause doubles each time, with jitter.
 * Starting values.
 */
export const BUSY_RETRIES = 6;
export const BUSY_BACKOFF_MS = 50;

/**
 * Several processes write one silo: one MCP server per Claude Code session,
 * and a `reverie serve` beside them (docs/SPEC.md section 10; host-lock.ts
 * says why `mcp` takes no lock). Prisma opens every interactive transaction on
 * SQLite with BEGIN IMMEDIATE, so the write lock is taken before anything is
 * read and a transaction never works from a snapshot another process has
 * since changed; busy_timeout makes the wait for that lock a wait, not an
 * error. What is left is a wait longer than busy_timeout under heavy
 * contention, or a wait for this process's own connection longer than
 * maxWait. Both leave nothing written, so the transaction is run again.
 */
export function isBusy(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  // P1008 timed out, P2028 could not start the transaction in time, P2034 a
  // write conflict, retry the transaction.
  if (code === "P1008" || code === "P2028" || code === "P2034") return true;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && /SQLITE_BUSY|database is locked|database table is locked/i.test(message);
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn` atomically. Given the silo, opens a transaction; given a
 * transaction, runs inside it, so a caller composing several domain calls
 * (an import, a reconcile) keeps them all in one. A transaction that finds
 * the file busy (isBusy) is rolled back and run again from the top, a bounded
 * number of times, so `fn` reads only what the database holds and keeps no
 * state of its own across attempts.
 */
export async function atomic<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!("$transaction" in db && typeof db.$transaction === "function")) return fn(db as Tx);
  const silo = db as Silo;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await silo.$transaction(fn, { timeout: TRANSACTION_TIMEOUT_MS, maxWait: TRANSACTION_MAX_WAIT_MS });
    } catch (error) {
      if (!isBusy(error) || attempt >= BUSY_RETRIES) throw error;
      const backoff = BUSY_BACKOFF_MS * 2 ** attempt;
      await pause(backoff + Math.floor(Math.random() * backoff));
    }
  }
}
