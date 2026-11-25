import type { MemoryScope, MemoryState } from "../schemas/enums.js";

/**
 * FTS5 over memory_fts, and the one job that matters before any of it:
 * turning text into a MATCH expression that cannot do anything surprising.
 *
 * FTS5 has a query language. Bare text is not in it: a stray quote is a syntax
 * error, a colon is a column filter, and AND, OR, NOT and NEAR are operators.
 * Every token is therefore quoted into a literal. This is the shape of
 * Fellowship's storage/search.ts, with the one query Reverie's domain needs so
 * far: the nearest memories to a piece of text, for reconcile.
 *
 * search-sql.ts beside this file is the migration side of the search layer
 * (which tables Prisma must never drop); this is the query side.
 */

/** Characters that mean something to FTS5 and nothing to a person. */
const TOKEN_SPLIT = /[^\p{L}\p{N}_]+/u;

export interface MatchQuery {
  /** The expression to hand to MATCH. */
  expression: string;
  /** The words behind it. */
  tokens: string[];
}

function literal(token: string): string {
  return `"${token.replace(/"/g, '""')}"`;
}

/**
 * A search box's contents as an FTS5 expression, every token required, or
 * null when there is nothing to search for. The last token is a prefix unless
 * `prefix` is false.
 */
export function toMatchQuery(raw: string, options: { prefix?: boolean } = {}): MatchQuery | null {
  const tokens = raw
    .trim()
    .split(TOKEN_SPLIT)
    .filter((token) => token.length > 0);
  if (tokens.length === 0) return null;
  const prefix = options.prefix !== false;
  const quoted = tokens.map((token, index) =>
    prefix && index === tokens.length - 1 ? `${literal(token)}*` : literal(token),
  );
  return { expression: quoted.join(" "), tokens };
}

/**
 * Words too common to say anything about which memory a text is near.
 * English only, short on purpose. Starting value.
 */
export const NEIGHBOUR_STOPWORDS: ReadonlySet<string> = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "but", "by", "for", "from", "had", "has",
  "have", "he", "her", "his", "i", "if", "in", "into", "is", "it", "its", "me", "my", "of", "on",
  "or", "our", "she", "so", "that", "the", "their", "them", "then", "there", "they", "this", "to",
  "was", "we", "were", "what", "when", "which", "who", "will", "with", "you", "your",
]);

/** The most terms one neighbour query carries. Starting value. */
export const NEIGHBOUR_MAX_TERMS = 32;

/**
 * Text as an any-of-these-words expression: each distinct word once, in the
 * order first written, lowercased, stopwords and single characters dropped,
 * at most NEIGHBOUR_MAX_TERMS of them, joined with OR. BM25 then ranks the
 * memories sharing the most (and the rarest) words first. Null when nothing
 * is left to search for.
 */
export function toNeighbourQuery(...texts: string[]): MatchQuery | null {
  const tokens: string[] = [];
  for (const text of texts) {
    for (const raw of text.split(TOKEN_SPLIT)) {
      const token = raw.toLowerCase();
      if (token.length < 2 || NEIGHBOUR_STOPWORDS.has(token) || tokens.includes(token)) continue;
      tokens.push(token);
      if (tokens.length >= NEIGHBOUR_MAX_TERMS) break;
    }
    if (tokens.length >= NEIGHBOUR_MAX_TERMS) break;
  }
  if (tokens.length === 0) return null;
  return { expression: tokens.map(literal).join(" OR "), tokens };
}

/**
 * BM25 column weights for title, body, why and tagText, in the column order of
 * fts.sql. A word in the title says more about what a memory is than the same
 * word in its body. Starting value.
 */
export const FTS_WEIGHTS = { title: 2, body: 1, why: 0.5, tagText: 1 } as const;

export interface MemoryFtsFilter {
  /** Only rows in one of these states. Defaults to active only. */
  states?: readonly MemoryState[];
  /**
   * Only rows matching one of these scope pairs. A null scopeRef matches a row
   * whose scopeRef is null. Absent means every scope.
   */
  scopes?: ReadonlyArray<{ scope: MemoryScope; scopeRef: string | null }>;
  /** The most hits returned. */
  limit: number;
}

export interface MemoryFtsHit {
  id: string;
  /** BM25 as FTS5 reports it: lower is better. */
  bm25: number;
}

/** What searchMemoryFts needs of a client: one raw query. */
export interface RawQueryable {
  $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T>;
}

/**
 * The memories a MATCH expression finds, best first by weighted BM25, ties
 * broken by call number so the same library always gives the same order.
 */
export async function searchMemoryFts(
  db: RawQueryable,
  expression: string,
  filter: MemoryFtsFilter,
): Promise<MemoryFtsHit[]> {
  const params: unknown[] = [expression];
  const where: string[] = [`"memory_fts" MATCH ?`];

  const states = filter.states ?? ["active"];
  if (states.length === 0) return [];
  where.push(`m."state" IN (${states.map(() => "?").join(", ")})`);
  params.push(...states);

  if (filter.scopes !== undefined) {
    if (filter.scopes.length === 0) return [];
    const pairs = filter.scopes.map((pair) => {
      params.push(pair.scope);
      if (pair.scopeRef === null) return `(m."scope" = ? AND m."scopeRef" IS NULL)`;
      params.push(pair.scopeRef);
      return `(m."scope" = ? AND m."scopeRef" = ?)`;
    });
    where.push(`(${pairs.join(" OR ")})`);
  }

  params.push(Math.max(0, Math.floor(filter.limit)));
  const { title, body, why, tagText } = FTS_WEIGHTS;
  const rows = await db.$queryRawUnsafe<Array<{ id: string; bm25: number }>>(
    `SELECT m."id" AS "id", bm25("memory_fts", ${title}, ${body}, ${why}, ${tagText}) AS "bm25"
       FROM "memory_fts"
       JOIN "Memory" AS m ON m."rowid" = "memory_fts"."rowid"
      WHERE ${where.join(" AND ")}
      ORDER BY "bm25" ASC, m."callNumber" ASC
      LIMIT ?`,
    ...params,
  );
  return rows.map((row) => ({ id: row.id, bm25: Number(row.bm25) }));
}
