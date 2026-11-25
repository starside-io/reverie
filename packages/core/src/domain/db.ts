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
 * Run `fn` atomically. Given the silo, opens a transaction; given a
 * transaction, runs inside it, so a caller composing several domain calls
 * (an import, a reconcile) keeps them all in one.
 */
export async function atomic<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if ("$transaction" in db && typeof db.$transaction === "function") {
    return (db as Silo).$transaction(fn, { timeout: TRANSACTION_TIMEOUT_MS });
  }
  return fn(db as Tx);
}
