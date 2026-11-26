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
// From M7 it also reads a folder through the markdown connector: a markdown
// mirror (two-way, file by file) or a Claude Code memory directory (import
// once, read only). shared/folder-import.ts holds both. Every import that
// writes takes a backup of the silo first, through the storage port
// (section 25: `VACUUM INTO`, before every import).

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
import {
  applyClaudeCode,
  applyNotes,
  MARKDOWN_CONNECTOR,
  prepareClaudeCode,
  prepareMirror,
  pullFolder,
  shownReport,
  type FolderReport,
} from "../shared/folder-import.js";
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
  /** What is being imported: a snapshot, a markdown mirror folder, or a Claude Code memory directory. */
  from: z.enum(["snapshot", "markdown", "claude_code"]).default("snapshot"),
  /** The snapshot, as memory.export returned it. */
  snapshot: z.unknown().optional(),
  /** A mirror folder or a Claude Code memory directory, as an absolute path on the host. */
  folder: z.string().trim().min(1).max(4096).optional(),
  /**
   * For a Claude Code memory directory: the registered project it belongs to,
   * by slug. Everything but `user` memories is scoped to it. With none, every
   * memory lands global. Never guessed from the folder.
   */
  project: z.string().trim().min(1).max(64).optional(),
  /** merge lets the file win row by row; replace deletes every table the file covers first. */
  mode: importModeSchema.default("merge"),
  /** Plans the import and writes nothing. A replace needs one first. */
  dryRun: z.boolean().default(false),
  /** For a replace: the acknowledgement the dry run returned, unchanged. */
  acknowledge: z.string().trim().min(1).max(200).optional(),
  confirmedByUser,
});

export type ImportToolInput = z.input<typeof importInputSchema>;
type ParsedImportInput = z.output<typeof importInputSchema>;

export type ImportDryRunResult = {
  mode: "merge" | "replace";
  written: false;
  from: "snapshot" | "markdown" | "claude_code";
  /** What the import would add, change and remove, per collection. Empty for a Claude Code directory: its folder report says it. */
  plan: ImportPlan;
  /** For a replace, every row it deletes first. Null for a merge, which deletes nothing. */
  wouldDestroy: TableCounts | null;
  /** For a replace, what the owner's yes is bound to. Pass it back as `acknowledge`. Null for a merge. */
  acknowledgement: string | null;
  /** For a folder: what each file comes to. */
  folder?: FolderReport;
};

export type ImportWriteResult = {
  mode: "merge" | "replace";
  written: true;
  from: "snapshot" | "markdown" | "claude_code";
  /** Rows the snapshot part wrote. All zero for a Claude Code directory: its folder report says it. */
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
  /**
   * The file name of the copy of the silo taken before anything was written,
   * as the host named it. Null when the host offers no backup.
   */
  backup: string | null;
  /** For a folder: what each file came to. */
  folder?: FolderReport;
  /** For a Claude Code directory: `[[other-name]]` links written as elaborates links. */
  links?: number;
};

export type ImportToolResult = ImportDryRunResult | ImportWriteResult;

/** The acknowledgement prefix. Starting value. */
const ACK_PREFIX = "replace:v1:";

/** A digest over what is imported and the rows a replace would destroy now. */
async function acknowledgementFor(ctx: ToolContext, what: unknown): Promise<{ ack: string; plan: ReplacePlan }> {
  const plan = await planReplace(ctx.db);
  const digest = sha256(JSON.stringify({ file: sha256(JSON.stringify(what)), destroys: plan.destroys }));
  return { ack: `${ACK_PREFIX}${digest.slice(0, 32)}`, plan };
}

/** A replace runs only with the acknowledgement its dry run handed back for this file and this library. */
async function requireAcknowledgement(ctx: ToolContext, input: ParsedImportInput, what: unknown): Promise<void> {
  if (input.mode !== "replace") return;
  if (!input.acknowledge) {
    throw new ToolError(
      "refused",
      "A replace deletes the library first. Run memory.import with dryRun true, show the owner what it would destroy, and pass the acknowledgement it returns. Nothing was written.",
    );
  }
  const { ack, plan } = await acknowledgementFor(ctx, what);
  if (ack !== input.acknowledge) {
    throw new ToolError(
      "conflict",
      "The acknowledgement does not match this file and this library as they stand: the file differs from the one planned, or the library changed since. Run the dry run again and show the owner the new counts. Nothing was written.",
      { wouldDestroy: plan.destroys },
    );
  }
}

/** The copy of the silo taken before an import writes anything. */
async function takeBackup(ctx: ToolContext): Promise<string | null> {
  const backup = ctx.ports.storage.backup;
  if (!backup) return null;
  try {
    return (await backup.call(ctx.ports.storage, "import")).file;
  } catch (error) {
    throw new ToolError(
      "unavailable",
      `The backup taken before every import failed, so nothing was imported: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Vectors, the import itself, and the written events: one snapshot into the silo. */
async function writeSnapshot(
  ctx: ToolContext,
  snapshot: unknown,
  mode: "merge" | "replace",
  options: { keepSupersededBy?: ReadonlySet<string> } = {},
): Promise<Pick<ImportWriteResult, "counts" | "destroyed" | "needsEmbedding" | "embedded">> {
  // Vectors for what the import will write, computed before its transaction opens.
  const setup = embeddingSetup(ctx);
  let prepared = new Map<string, PreparedVector>();
  if (setup) {
    const candidates = await importEmbeddingCandidates(ctx.db, snapshot, mode);
    prepared = await prepareVectors(
      setup.embed,
      setup.target,
      candidates.map((memory) => ({ memoryId: memory.memoryId, text: embeddingText(memory) })),
    );
  }

  const result = await importSnapshot(ctx.db, snapshot, mode, {
    actor: "import",
    at: ctx.now,
    ...(options.keepSupersededBy ? { keepSupersededBy: options.keepSupersededBy } : {}),
  });

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
    counts: result.counts,
    destroyed: result.destroyed,
    needsEmbedding: missing.length,
    ...(embedded !== undefined ? { embedded } : {}),
  };
}

async function fromSnapshot(ctx: ToolContext, input: ParsedImportInput): Promise<ImportToolResult> {
  if (input.snapshot === undefined) {
    throw new ToolError("invalid_input", "Pass the snapshot to import, as memory.export returned it.");
  }
  disciplineOnImport(input.snapshot);

  if (input.dryRun) {
    const plan = await planImport(ctx.db, input.snapshot, input.mode);
    if (input.mode === "merge") {
      return { mode: "merge", written: false, from: "snapshot", plan, wouldDestroy: null, acknowledgement: null };
    }
    const { ack, plan: replace } = await acknowledgementFor(ctx, input.snapshot);
    return { mode: "replace", written: false, from: "snapshot", plan, wouldDestroy: replace.destroys, acknowledgement: ack };
  }

  await requireAcknowledgement(ctx, input, input.snapshot);
  const backup = await takeBackup(ctx);
  const written = await writeSnapshot(ctx, input.snapshot, input.mode);
  return { mode: input.mode, written: true, from: "snapshot", ...written, backup };
}

async function fromMirror(ctx: ToolContext, input: ParsedImportInput, folder: string): Promise<ImportToolResult> {
  const files = await pullFolder(ctx, "read_mirror", folder);
  const prepared = await prepareMirror(ctx, files, input.mode);
  // What the owner's yes to a replace is bound to: every file as read.
  const asRead = files.map((file) => [file.path, file.sha256 ?? sha256(`${JSON.stringify(file.data)}\n${file.body}`)]);

  if (input.dryRun) {
    const plan = await planImport(ctx.db, prepared.snapshot, input.mode);
    const report = shownReport({ ...prepared.report, notes: prepared.notes.map((note) => note.outcome) });
    if (input.mode === "merge") {
      return { mode: "merge", written: false, from: "markdown", plan, wouldDestroy: null, acknowledgement: null, folder: report };
    }
    const { ack, plan: replace } = await acknowledgementFor(ctx, asRead);
    return { mode: "replace", written: false, from: "markdown", plan, wouldDestroy: replace.destroys, acknowledgement: ack, folder: report };
  }

  await requireAcknowledgement(ctx, input, asRead);
  const backup = await takeBackup(ctx);
  const written = await writeSnapshot(ctx, prepared.snapshot, input.mode, { keepSupersededBy: prepared.keepSupersededBy });
  const notes = await applyNotes(ctx, prepared.notes);

  // The edits just taken in are the mirror's again: the next export may write over them.
  const connectors = ctx.ports.connectors;
  if (connectors?.push && Object.keys(prepared.adopt).length > 0) {
    try {
      await connectors.push(MARKDOWN_CONNECTOR, { op: "adopt", folder, files: prepared.adopt });
    } catch {
      // The import committed; a later export keeps those files and says so.
    }
  }

  return {
    mode: input.mode,
    written: true,
    from: "markdown",
    ...written,
    backup,
    folder: shownReport({ ...prepared.report, notes }),
  };
}

async function fromClaudeCode(ctx: ToolContext, input: ParsedImportInput, folder: string): Promise<ImportToolResult> {
  if (input.mode === "replace") {
    throw new ToolError(
      "invalid_input",
      "A Claude Code memory directory is imported once, in merge mode: it adds memories and never replaces the library. Nothing was written.",
    );
  }
  const files = await pullFolder(ctx, "read_claude_code", folder);
  const prepared = await prepareClaudeCode(ctx, files, input.project);
  if (input.dryRun) {
    const plan: ImportPlan = { mode: "merge", collections: [], destroys: null, forgottenInFile: [] };
    return { mode: "merge", written: false, from: "claude_code", plan, wouldDestroy: null, acknowledgement: null, folder: shownReport(prepared.report) };
  }
  const backup = await takeBackup(ctx);
  const { outcomes, links } = await applyClaudeCode(ctx, prepared);
  const created = outcomes.filter((outcome) => outcome.action === "create").length;
  return {
    mode: "merge",
    written: true,
    from: "claude_code",
    counts: {
      sections: 0,
      shelves: 0,
      projects: 0,
      tags: 0,
      sources: 0,
      memories: created,
      memoryTags: 0,
      refs: 0,
      citations: 0,
      versions: 0,
      aliases: 0,
      links,
      forgottenSkipped: prepared.report.forgotten.length,
      versionsAppended: 0,
    },
    destroyed: null,
    needsEmbedding: 0,
    backup,
    folder: shownReport({ ...prepared.report, applied: created, notes: outcomes }),
    links,
  };
}

export const tool = defineTool({
  name: "memory.import",
  title: "Import",
  kind: "needs-ok",
  summary:
    "Reads a snapshot, a markdown mirror folder (from: markdown, folder) or a Claude Code memory directory (from: claude_code, folder, optional project slug) into the library, after a backup of the silo. merge deletes nothing: an edited mirror file comes back as a new version, an unchanged one is a no-op, a note written by hand is remembered, and a Claude Code directory is imported once and never written to. replace deletes every table the file covers first: run it with dryRun true, show the owner wouldDestroy, then run it again with the acknowledgement the dry run returned.",
  input: importInputSchema,
  async handler(ctx, input): Promise<ImportToolResult> {
    if (input.from === "snapshot") return fromSnapshot(ctx, input);
    if (!input.folder) {
      throw new ToolError("invalid_input", "Pass the folder to import, as an absolute path on this machine.");
    }
    return input.from === "markdown" ? fromMirror(ctx, input, input.folder) : fromClaudeCode(ctx, input, input.folder);
  },
});
