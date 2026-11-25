// memory.import. docs/SPEC.md section 15, "Needs OK, 6" table, row
// `memory.import` ("Replace mode names the row counts it will destroy");
// section 16, gate "Carried over from Fellowship" (snapshot round trip);
// section 25 (operational notes); guardrail 1.
//
// The handshake follows Fellowship's people.import: a dry run writes nothing
// and names what a replace would destroy. Reverie adds one step, so that the
// owner's yes is bound to the plan they saw: the dry run hands back an
// acknowledgement, a digest over the file and the counts it will destroy,
// and a replace runs only with that acknowledgement. A file swapped for
// another, or a library that changed since the plan was read, no longer
// matches, and nothing is destroyed.
//
// Markdown mirror folders and Claude Code memory directories are M7. Only
// snapshots are accepted now.

import { z } from "zod";

import {
  importEmbeddingCandidates,
  importModeSchema,
  importSnapshot,
  planImport,
  planReplace,
  type ImportCounts,
  type ImportPlan,
  type ReplacePlan,
  type TableCounts,
} from "../../domain/transfer/import.js";
import { checkSecrets, runDiscipline, type DisciplineFinding } from "../../domain/discipline.js";
import { parseInput } from "../../domain/errors.js";
import { snapshotSchema } from "../../domain/transfer/snapshot.js";
import { sha256 } from "../../domain/versions.js";
import { defineTool, ToolError, type ToolContext } from "../registry.js";
import { confirmedByUser } from "../shared/inputs.js";
import { embeddingSetup } from "../shared/embedding.js";
import { emitWritten } from "../shared/write-common.js";
import { embeddingText, prepareVectors, storeVector, type PreparedVector } from "../../domain/embeddings.js";

/**
 * Discipline on an import (section 7: every write path runs the checks).
 * Each memory in the file is checked at the trust it carries: no secret in
 * its title, body, why, how to apply, quotes or version history; nothing
 * instruction shaped from an external source, and no procedure from one
 * (guardrail 4); no relative date in a body. The sensitive check is left
 * out: the file does not record whether the owner asked for a sensitive
 * memory to be kept, and a backup of one the owner did keep must restore.
 * One finding refuses the whole file, before anything is read into the
 * silo, naming the memory by call number.
 */
function disciplineOnImport(raw: unknown): void {
  const snapshot = parseInput(snapshotSchema, raw);
  const refused: Array<{ call: string; findings: Array<Pick<DisciplineFinding, "check" | "code" | "label" | "reason">> }> = [];
  const shown = (findings: readonly DisciplineFinding[]) =>
    findings.map(({ check, code, label, reason }) => ({ check, code, label, reason }));
  for (const memory of snapshot.memories) {
    const findings: DisciplineFinding[] = [];
    // The instruction check refuses a procedure at trust external too.
    const verdict = runDiscipline({
      kind: memory.kind,
      title: memory.title,
      body: memory.body,
      why: memory.why,
      howToApply: memory.howToApply,
      sourceTrust: memory.trust,
      // Stands in for the ask the file cannot carry: the sensitive check is skipped.
      explicitAsk: true,
    });
    findings.push(...verdict.findings);
    for (const citation of memory.sources) {
      findings.push(...checkSecrets({ kind: memory.kind, title: "", body: citation.quote, sourceTrust: memory.trust }).findings);
    }
    if (findings.length > 0) refused.push({ call: memory.callNumber, findings: shown(findings) });
  }
  for (const version of snapshot.versions) {
    if (!version.body) continue;
    const findings = checkSecrets({ kind: "fact", title: "", body: version.body, sourceTrust: "stated" }).findings;
    if (findings.length > 0) refused.push({ call: `version ${version.id}`, findings: shown(findings) });
  }
  if (refused.length > 0) {
    const named = refused.slice(0, 10).map((entry) => entry.call).join(", ");
    throw new ToolError("refused", `Nothing was imported. Discipline refused what the file holds for ${named}.`, {
      refused: refused.slice(0, 50),
    });
  }
}

export const importInputSchema = z.object({
  /** What is being imported. Only `snapshot` is built; the other two are M7. */
  from: z.enum(["snapshot", "markdown", "claude_code"]).default("snapshot"),
  /** The snapshot, as memory.export returned it. */
  snapshot: z.unknown().optional(),
  /** A mirror folder or a Claude Code memory directory. Accepted from M7. */
  folder: z.string().trim().min(1).max(4096).optional(),
  /** merge lets the file win row by row; replace deletes every table the file covers first. */
  mode: importModeSchema.default("merge"),
  /** Plans the import and writes nothing. A replace needs one first. */
  dryRun: z.boolean().default(false),
  /** For a replace: the acknowledgement the dry run returned, unchanged. */
  acknowledge: z.string().trim().min(1).max(200).optional(),
  confirmedByUser,
});

export type ImportToolInput = z.input<typeof importInputSchema>;

export type ImportDryRunResult = {
  mode: "merge" | "replace";
  written: false;
  /** What the import would add, change and remove, per collection. */
  plan: ImportPlan;
  /** For a replace, every row it deletes first. Null for a merge, which deletes nothing. */
  wouldDestroy: TableCounts | null;
  /** For a replace, what the owner's yes is bound to. Pass it back as `acknowledge`. Null for a merge. */
  acknowledgement: string | null;
};

export type ImportWriteResult = {
  mode: "merge" | "replace";
  written: true;
  counts: ImportCounts;
  /** What a replace deleted first. Null for a merge. */
  destroyed: ReplacePlan | null;
  /**
   * Memories left with no embedding, for the host's re-embed hook. With a
   * models port and embedding.model set, the import computes them itself
   * before its transaction opens and this counts the ones the model failed.
   */
  needsEmbedding: number;
  /** Vectors written for imported memories. Absent when vectors are off. */
  embedded?: number;
};

export type ImportToolResult = ImportDryRunResult | ImportWriteResult;

/** The acknowledgement prefix. Starting value. */
const ACK_PREFIX = "replace:v1:";

/** A digest over the file and the rows a replace would destroy now. */
async function acknowledgementFor(ctx: ToolContext, snapshot: unknown): Promise<{ ack: string; plan: ReplacePlan }> {
  const plan = await planReplace(ctx.db);
  const digest = sha256(JSON.stringify({ file: sha256(JSON.stringify(snapshot)), destroys: plan.destroys }));
  return { ack: `${ACK_PREFIX}${digest.slice(0, 32)}`, plan };
}

export const tool = defineTool({
  name: "memory.import",
  title: "Import",
  kind: "needs-ok",
  summary:
    "Reads a snapshot back in. merge lets the file win row by row and deletes nothing. replace deletes every table the file covers first: run it with dryRun true, show the owner wouldDestroy, then run it again with the acknowledgement the dry run returned. Markdown mirror folders and Claude Code memory directories are not built yet.",
  input: importInputSchema,
  async handler(ctx, input): Promise<ImportToolResult> {
    if (input.from !== "snapshot") {
      throw new ToolError(
        "not_implemented",
        input.from === "markdown"
          ? "Importing a markdown mirror folder is not built yet (M7). Import a snapshot from memory.export."
          : "Importing a Claude Code memory directory is not built yet (M7). Import a snapshot from memory.export.",
        { from: input.from },
      );
    }
    if (input.snapshot === undefined) {
      throw new ToolError("invalid_input", "Pass the snapshot to import, as memory.export returned it.");
    }

    disciplineOnImport(input.snapshot);

    if (input.dryRun) {
      const plan = await planImport(ctx.db, input.snapshot, input.mode);
      if (input.mode === "merge") {
        return { mode: "merge", written: false, plan, wouldDestroy: null, acknowledgement: null };
      }
      const { ack, plan: replace } = await acknowledgementFor(ctx, input.snapshot);
      return { mode: "replace", written: false, plan, wouldDestroy: replace.destroys, acknowledgement: ack };
    }

    if (input.mode === "replace") {
      if (!input.acknowledge) {
        throw new ToolError(
          "refused",
          "A replace deletes the library first. Run memory.import with dryRun true, show the owner what it would destroy, and pass the acknowledgement it returns. Nothing was written.",
        );
      }
      const { ack, plan } = await acknowledgementFor(ctx, input.snapshot);
      if (ack !== input.acknowledge) {
        throw new ToolError(
          "conflict",
          "The acknowledgement does not match this file and this library as they stand: the file differs from the one planned, or the library changed since. Run the dry run again and show the owner the new counts. Nothing was written.",
          { wouldDestroy: plan.destroys },
        );
      }
    }

    // Vectors for what the import will write, computed before its transaction opens.
    const setup = embeddingSetup(ctx);
    let prepared = new Map<string, PreparedVector>();
    if (setup) {
      const candidates = await importEmbeddingCandidates(ctx.db, input.snapshot, input.mode);
      prepared = await prepareVectors(
        setup.embed,
        setup.target,
        candidates.map((memory) => ({ memoryId: memory.memoryId, text: embeddingText(memory) })),
      );
    }

    const result = await importSnapshot(ctx.db, input.snapshot, input.mode, { actor: "import", at: ctx.now });

    // Written right after the commit: one vector per memory the import left without one.
    let missing = result.needsEmbedding;
    let embedded: number | undefined;
    if (setup) {
      missing = [];
      embedded = 0;
      // A merge that changed only a title keeps its old row until this overwrites it.
      for (const memoryId of new Set([...result.needsEmbedding, ...prepared.keys()])) {
        const vector = prepared.get(memoryId);
        const outcome = vector ? await storeVector(ctx.db, memoryId, vector) : null;
        if (outcome?.status === "written") embedded += 1;
        else missing.push(memoryId);
      }
    }

    // memory.memory.written for each memory created or changed, door import.
    const rows = await ctx.db.memory.findMany({
      where: { id: { in: result.written.map((entry) => entry.memoryId) } },
      select: { id: true, callNumber: true, kind: true, trust: true },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const entry of result.written) {
      const row = byId.get(entry.memoryId);
      if (row) emitWritten(ctx, row, entry.operation, {}, "import");
    }

    return {
      mode: result.mode,
      written: true,
      counts: result.counts,
      destroyed: result.destroyed,
      needsEmbedding: missing.length,
      ...(embedded !== undefined ? { embedded } : {}),
    };
  },
});
