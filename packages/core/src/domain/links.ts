// Links between memories. docs/SPEC.md section 11, `MemoryLink`: fromId,
// toId, relation (`elaborates`, `contradicts`, `derived-from`); `contradicts`
// is what the conflicts screen reads.
//
// A link says how two entries relate; it is not part of either one's content,
// so it writes no MemoryVersion. A memory never links to itself, and one pair
// holds one link per relation. `contradicts` reads the same both ways, so B
// contradicts A is the same link as A contradicts B. Starting values.

import type { MemoryLink } from "../../generated/prisma/index.js";
import { LinkRelation } from "../schemas/enums.js";
import { atomic, type Db } from "./db.js";
import { DomainError, parseInput } from "./errors.js";

/** Relations that read the same in both directions. */
export const SYMMETRIC_RELATIONS: readonly LinkRelation[] = ["contradicts"];

export async function createLink(
  db: Db,
  input: { fromId: string; toId: string; relation: LinkRelation },
): Promise<MemoryLink> {
  const relation = parseInput(LinkRelation, input.relation);
  if (input.fromId === input.toId) {
    throw new DomainError("refused", "A memory is not linked to itself.");
  }
  return atomic(db, async (tx) => {
    const ends = await tx.memory.findMany({
      where: { id: { in: [input.fromId, input.toId] } },
      select: { id: true, callNumber: true },
    });
    if (ends.length !== 2) throw new DomainError("not_found", "Both memories must exist.");

    const pairs = [{ fromId: input.fromId, toId: input.toId }];
    if (SYMMETRIC_RELATIONS.includes(relation)) pairs.push({ fromId: input.toId, toId: input.fromId });
    const existing = await tx.memoryLink.findFirst({ where: { relation, OR: pairs } });
    if (existing) {
      throw new DomainError("conflict", `Those two are already linked as ${relation}.`, { linkId: existing.id, relation });
    }
    return tx.memoryLink.create({ data: { fromId: input.fromId, toId: input.toId, relation } });
  });
}

/** Every link touching one memory, either end, oldest first. */
export async function linksOf(db: Db, memoryId: string): Promise<MemoryLink[]> {
  return db.memoryLink.findMany({
    where: { OR: [{ fromId: memoryId }, { toId: memoryId }] },
    orderBy: { createdAt: "asc" },
  });
}
