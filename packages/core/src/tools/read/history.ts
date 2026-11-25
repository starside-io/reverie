// memory.history. docs/SPEC.md section 15, "Read, 18" table, row
// `memory.history`; section 16, gate "Supersede, never overwrite" (the
// previous content is readable through history; asOf returns what was valid
// then) and "Forget is real" (a redacted version keeps operation, actor and
// time, and nothing else).

import { z } from "zod";

import { aliasesOf } from "../../domain/catalogue/call-number.js";
import type { Db } from "../../domain/db.js";
import { RECALL_NOTICE } from "../../domain/recall/frame.js";
import { asOf, history, type VersionContent, type VersionRow } from "../../domain/versions.js";
import { dateTimeSchema } from "../../schemas/common.js";
import type { VersionOperation } from "../../schemas/enums.js";
import { defineTool } from "../registry.js";
import { callSchema } from "../shared/inputs.js";
import { findByCall } from "../shared/views.js";

export const historyInputSchema = z.object({
  call: callSchema,
  /** What was valid at this time, across the supersede chain. */
  asOf: dateTimeSchema.optional(),
});

export interface VersionView {
  id: string;
  operation: VersionOperation;
  actor: string;
  at: string;
  contentSha256: string | null;
  /** True once redacted: content is then null. */
  redacted: boolean;
  content: VersionContent | null;
}

export type HistoryResult =
  | {
      notice: typeof RECALL_NOTICE;
      mode: "history";
      memoryId: string;
      call: string;
      /** Oldest first. */
      versions: VersionView[];
      /**
       * Memories folded into this one by memory.merge, each with its own
       * versions, oldest first: the absorbed row is gone, its history is not.
       * Found by the numbers they were known by, now aliases of this memory.
       */
      absorbed: Array<{ memoryId: string; call: string; versions: VersionView[] }>;
    }
  | {
      notice: typeof RECALL_NOTICE;
      mode: "asOf";
      memoryId: string;
      call: string;
      asOf: string;
      /** The entry valid then, in this memory's supersede chain, or null when none was. */
      valid: { memoryId: string; call: string; version: VersionView } | null;
    };

function versionView(row: VersionRow): VersionView {
  return {
    id: row.id,
    operation: row.operation,
    actor: row.actor,
    at: row.at.toISOString(),
    contentSha256: row.contentSha256,
    redacted: row.content === null,
    content: row.content,
  };
}

/**
 * The histories of memories merged into this one. A merge deletes the
 * absorbed row and points its numbers at the survivor, so they are found by
 * those numbers: version rows of a memory with no row left whose content
 * names one of them. A forgotten memory's versions are redacted and name
 * nothing, so they are never found here.
 */
async function absorbedHistories(
  db: Db,
  memoryId: string,
): Promise<Array<{ memoryId: string; call: string; versions: VersionView[] }>> {
  const aliases = await aliasesOf(db, memoryId);
  if (aliases.length === 0) return [];
  const rows = await db.memoryVersion.findMany({
    where: {
      memoryId: { not: memoryId },
      OR: aliases.map((alias) => ({ body: { contains: `"callNumber":${JSON.stringify(alias)}` } })),
    },
    select: { memoryId: true },
    distinct: ["memoryId"],
  });
  const ids = rows.map((row) => row.memoryId);
  const living = new Set(
    (await db.memory.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((row) => row.id),
  );
  const out: Array<{ memoryId: string; call: string; versions: VersionView[] }> = [];
  for (const id of ids.filter((candidate) => !living.has(candidate)).sort()) {
    const versions = await history(db, id);
    const last = [...versions].reverse().find((version) => version.content !== null);
    out.push({ memoryId: id, call: last?.content?.callNumber ?? "", versions: versions.map(versionView) });
  }
  return out.sort((a, b) => (a.call < b.call ? -1 : a.call > b.call ? 1 : 0));
}

export const tool = defineTool({
  name: "memory.history",
  title: "History",
  kind: "read",
  summary:
    "The version rows of one memory, oldest first, each with its operation, actor and time; redacted rows keep their place with no content. With asOf, the entry and version that were valid then, across the supersede chain.",
  input: historyInputSchema,
  async handler(ctx, input): Promise<HistoryResult> {
    const found = await findByCall(ctx, input.call);
    if (input.asOf) {
      const held = await asOf(ctx.db, found.memoryId, input.asOf);
      return {
        notice: RECALL_NOTICE,
        mode: "asOf",
        memoryId: found.memoryId,
        call: found.call,
        asOf: input.asOf.toISOString(),
        valid: held ? { memoryId: held.memoryId, call: held.callNumber, version: versionView(held.version) } : null,
      };
    }
    const versions = await history(ctx.db, found.memoryId);
    return {
      notice: RECALL_NOTICE,
      mode: "history",
      memoryId: found.memoryId,
      call: found.call,
      versions: versions.map(versionView),
      absorbed: await absorbedHistories(ctx.db, found.memoryId),
    };
  },
  auditIds: (input, result) => ({
    calls: [
      input.call,
      ...(result ? [result.call] : []),
      ...(result && result.mode === "asOf" && result.valid ? [result.valid.call] : []),
    ],
    ...(result ? { memoryIds: [result.memoryId] } : {}),
  }),
});
