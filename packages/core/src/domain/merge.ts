// Merge: fold one memory into another. docs/SPEC.md section 15, "Needs OK, 6"
// table, row `memory.merge` (a starting reading: the design names the tool
// without describing it); section 5, "The call number" (it survives a move,
// it is never reissued); section 11 (CallNumberAlias, MemoryVersion).
//
// The survivor keeps its number and gains everything the absorbed memory
// carried: its sources with their quotes, its tags, its references, its
// links, and every number it was ever known by, now aliases of the survivor.
// The absorbed row is then removed. It is not forgotten: its versions keep
// their content (nothing is redacted), and a closing version on it names the
// survivor, so what it said is still readable through history. Both version
// rows a merge writes, the closing one on the absorbed memory and the new one
// on the survivor, carry the operation `merge`.

import type { Memory } from "../../generated/prisma/index.js";
import { aliasesOf, writeAlias } from "./catalogue/call-number.js";
import { attachTagsRaw, tagsOf } from "./catalogue/tags.js";
import { atomic, type Db, type Tx } from "./db.js";
import { DomainError } from "./errors.js";
import { appendVersion, memoryIdOf, snapshotMemory, type MutationOptions } from "./versions.js";

export interface MergeInput {
  /** The memory that stays, by id or call number (current or alias). */
  survivor: string | { id: string };
  /** The memory folded into it, by id or call number. */
  absorbed: string | { id: string };
}

export interface MergeResult {
  survivor: Memory;
  absorbedId: string;
  absorbedCall: string;
  /** Every number that named the absorbed memory, each now an alias of the survivor. */
  aliasesMoved: string[];
  sourcesAdded: number;
  tagsAdded: string[];
  refsAdded: number;
  linksMoved: number;
}

async function load(tx: Tx, ref: string | { id: string }, role: string): Promise<Memory> {
  const id = await memoryIdOf(tx, ref);
  const row = await tx.memory.findUnique({ where: { id } });
  if (!row) throw new DomainError("not_found", `No ${role} memory ${typeof ref === "string" ? ref : ref.id}.`);
  return row;
}

/**
 * Folds `absorbed` into `survivor`, in one transaction. Refused when they are
 * the same memory, when the survivor is not active, and when either is
 * superseded (history, kept as it stands). A retired memory may be absorbed.
 */
export async function mergeMemories(db: Db, input: MergeInput, options: MutationOptions): Promise<MergeResult> {
  return atomic(db, async (tx) => {
    const at = options.at ?? new Date();
    const survivor = await load(tx, input.survivor, "survivor");
    const absorbed = await load(tx, input.absorbed, "absorbed");

    if (survivor.id === absorbed.id) {
      throw new DomainError("invalid_input", `${survivor.callNumber} cannot be merged into itself.`);
    }
    if (survivor.state !== "active") {
      throw new DomainError("refused", `${survivor.callNumber} is ${survivor.state}; a merge keeps an active entry.`);
    }
    if (absorbed.state === "superseded") {
      throw new DomainError(
        "refused",
        `${absorbed.callNumber} was superseded and is history. Merge the entry that replaced it.`,
      );
    }

    // Sources: every citation the absorbed memory had, quote and all, unless
    // the survivor already cites that source (the first quote stands).
    const citations = await tx.memorySource.findMany({ where: { memoryId: absorbed.id } });
    let sourcesAdded = 0;
    for (const citation of citations) {
      const already = await tx.memorySource.findUnique({
        where: { memoryId_sourceId: { memoryId: survivor.id, sourceId: citation.sourceId } },
        select: { memoryId: true },
      });
      if (already) continue;
      await tx.memorySource.create({ data: { memoryId: survivor.id, sourceId: citation.sourceId, quote: citation.quote } });
      sourcesAdded += 1;
    }

    // Tags: the union. attachTagsRaw refreshes tagText for the FTS index.
    const tagsAdded = await attachTagsRaw(tx, survivor.id, await tagsOf(tx, absorbed.id));

    // References: attendees, occasion and mentions the survivor does not already carry.
    const survivorRefs = await tx.memoryRef.findMany({ where: { memoryId: survivor.id } });
    const key = (ref: { role: string; uri: string | null; label: string }) =>
      `${ref.role}|${ref.uri ?? `name:${ref.label.toLowerCase()}`}`;
    const held = new Set(survivorRefs.map(key));
    let refsAdded = 0;
    for (const ref of await tx.memoryRef.findMany({ where: { memoryId: absorbed.id } })) {
      if (held.has(key(ref))) continue;
      held.add(key(ref));
      await tx.memoryRef.create({
        data: { memoryId: survivor.id, role: ref.role, uri: ref.uri, label: ref.label, resolved: ref.resolved },
      });
      refsAdded += 1;
    }

    // Links: repointed to the survivor, dropping any that would join it to itself or repeat one it has.
    let linksMoved = 0;
    const links = await tx.memoryLink.findMany({ where: { OR: [{ fromId: absorbed.id }, { toId: absorbed.id }] } });
    for (const link of links) {
      const fromId = link.fromId === absorbed.id ? survivor.id : link.fromId;
      const toId = link.toId === absorbed.id ? survivor.id : link.toId;
      if (fromId === toId) continue;
      const exists = await tx.memoryLink.findUnique({
        where: { fromId_toId_relation: { fromId, toId, relation: link.relation } },
        select: { id: true },
      });
      if (exists) continue;
      await tx.memoryLink.create({ data: { fromId, toId, relation: link.relation } });
      linksMoved += 1;
    }

    // An entry the absorbed memory had superseded now points at the survivor.
    await tx.memory.updateMany({ where: { supersededById: absorbed.id }, data: { supersededById: survivor.id } });

    // The closing version on the absorbed memory: its content as it stood,
    // marked as folded into the survivor. Its earlier versions keep their content.
    const closing = await snapshotMemory(tx, absorbed.id);
    await appendVersion(tx, absorbed.id, {
      ...options,
      at,
      operation: "merge",
      content: { ...closing, state: "superseded", validTo: at.toISOString(), supersededById: survivor.id },
    });

    // Every number it held becomes an alias of the survivor, never reissued.
    const oldNumbers = await aliasesOf(tx, absorbed.id);
    await tx.callNumberAlias.updateMany({ where: { memoryId: absorbed.id }, data: { memoryId: survivor.id } });
    await tx.memory.delete({ where: { id: absorbed.id } });
    await writeAlias(tx, absorbed.callNumber, survivor.id);

    await appendVersion(tx, survivor.id, { ...options, at, operation: "merge" });

    return {
      survivor: await tx.memory.findUniqueOrThrow({ where: { id: survivor.id } }),
      absorbedId: absorbed.id,
      absorbedCall: absorbed.callNumber,
      aliasesMoved: [absorbed.callNumber, ...oldNumbers].sort(),
      sourcesAdded,
      tagsAdded,
      refsAdded,
      linksMoved,
    };
  });
}
