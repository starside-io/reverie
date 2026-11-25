/**
 * Reciprocal rank fusion of the two searches recall runs. docs/SPEC.md
 * section 14:
 *
 *   fused     = 1/(60 + rankFts) + 1/(60 + rankVec)    vectors absent: the first term alone
 *   relevance = fused / bestPossible(fused)            so the top rank in every list is 1.0
 *
 * `bestPossible` is the fused value of rank 1 in every list that ran: 2/61
 * with vectors, 1/61 without. Ranks are 1 based.
 */

export const RRF_K = 60;

export interface FuseInput {
  /** Memory ids in FTS5 BM25 order, best first. */
  fts: readonly string[];
  /**
   * Memory ids in cosine order, best first. `null` or absent when no model is
   * configured, so the vector search did not run. An empty array means it ran
   * and found nothing, and still counts toward `bestPossible`. Starting value.
   */
  vector?: readonly string[] | null;
}

export interface FusedHit {
  id: string;
  /** 1 based rank in the FTS list, null when absent from it. */
  rankFts: number | null;
  /** 1 based rank in the vector list, null when absent or when it did not run. */
  rankVec: number | null;
  fused: number;
  /** fused / bestPossible: 1.0 for rank 1 in every list that ran. */
  relevance: number;
}

/** The fused value of rank 1 in each of `listsRan` lists. */
export function bestPossible(listsRan: number): number {
  return listsRan / (RRF_K + 1);
}

/** One list's contribution at a 1 based rank. */
export function rrfTerm(rank: number): number {
  return 1 / (RRF_K + rank);
}

function ranks(list: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  list.forEach((id, index) => {
    // A repeated id keeps its best rank.
    if (!out.has(id)) out.set(id, index + 1);
  });
  return out;
}

/**
 * Fuses the lists into one, best first. Ties break on the FTS rank, then on
 * the id, so the same lists always give the same order.
 */
export function fuse(input: FuseInput): FusedHit[] {
  const vectorRan = input.vector !== null && input.vector !== undefined;
  const ftsRanks = ranks(input.fts);
  const vecRanks = vectorRan ? ranks(input.vector!) : new Map<string, number>();
  const best = bestPossible(vectorRan ? 2 : 1);

  const ids = new Set<string>([...ftsRanks.keys(), ...vecRanks.keys()]);
  const hits: FusedHit[] = [];
  for (const id of ids) {
    const rankFts = ftsRanks.get(id) ?? null;
    const rankVec = vecRanks.get(id) ?? null;
    const fused = (rankFts === null ? 0 : rrfTerm(rankFts)) + (rankVec === null ? 0 : rrfTerm(rankVec));
    hits.push({ id, rankFts, rankVec, fused, relevance: fused / best });
  }

  return hits.sort(
    (a, b) =>
      b.fused - a.fused ||
      (a.rankFts ?? Number.POSITIVE_INFINITY) - (b.rankFts ?? Number.POSITIVE_INFINITY) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}
