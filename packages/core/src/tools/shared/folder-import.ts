import { z } from "zod";

import { checkSecrets, runDiscipline, type DisciplineFinding } from "../../domain/discipline.js";
import { createLink } from "../../domain/links.js";
import { updateMemory } from "../../domain/memories.js";
import { getProject } from "../../domain/projects.js";
import { buildExportSnapshot } from "../../domain/transfer/export.js";
import {
  assembleSnapshot,
  memoryRevision,
  MirrorManifestError,
  mirrorReadFileSchema,
  readMirror,
  revisionKeys,
  type FreshNote,
  type MirrorRead,
  type MirrorReadFile,
  type MirrorRecord,
  type RevisionKeys,
} from "../../domain/transfer/mirror.js";
import { CLAUDE_CODE_INDEX, readClaudeCodeIndex, readClaudeCodeMemory, type ClaudeCodeMemory } from "../../domain/transfer/claude-code.js";
import { snapshotSchema, type ExportSnapshot, type SnapshotMemory } from "../../domain/transfer/snapshot.js";
import { sha256 } from "../../domain/versions.js";
import { dateOnlySchema, dayKey } from "../../schemas/common.js";
import { MemoryKind, TRUST_ORDER, type TrustTier } from "../../schemas/enums.js";
import { BODY_MAX_LENGTH, TITLE_MAX_LENGTH } from "../../schemas/memory.js";
import { shelfPathSchema } from "../../schemas/shelf.js";
import { ToolError, type ToolContext } from "../registry.js";
import { commitRemember, rememberInputSchema, type ParsedRememberInput } from "../write/remember.js";
import type { DraftedProvenance } from "./confirm-drafted.js";
import { capQuote } from "./session.js";
import { valuesOf } from "./host-values.js";

/**
 * memory.import from a folder: a markdown mirror, or a Claude Code memory
 * directory. docs/SPEC.md section 15, row `memory.import`; section 19, "The
 * markdown mirror"; section 24, "Claude Code's own memory".
 *
 * Core reads no file. It asks the `markdown` connector for what a folder
 * holds and gets back each file's front matter and body; everything below
 * works on that.
 *
 * A mirror folder, merge mode, file by file:
 *
 * - A file the mirror wrote and nobody touched since is left alone: an
 *   unchanged file imports as a no-op, whatever the library did meanwhile.
 * - A file edited in the folder comes back as a new version through the
 *   snapshot merge, never an in-place write; the content it replaces stays
 *   in history. When the library changed that memory too since the file was
 *   written (its `revision` no longer matches), it is a conflict, reported
 *   and left alone.
 * - An edit may not raise a memory's trust or turn it into a procedure: those
 *   go through review and memory.promote_procedure.
 * - A file that is gone deletes nothing. Replace mode is the only way a
 *   folder removes rows, and it names its counts first.
 * - A markdown file with no `id` is a note written by hand: it is remembered
 *   at trust stated (the owner's own words in their own folder, imported with
 *   their yes), cited to its path in the folder, on the shelf its front
 *   matter or folder names, else its project's shelf, else Returns.
 *   Importing it again changes nothing, or writes a new version when it was
 *   edited.
 * - A file that does not parse is reported for that file; the rest go on.
 *
 * A Claude Code memory directory is imported once and read only: each memory
 * file becomes one memory (claude-code.ts has the mapping), cited to the
 * file by name, at trust confirmed. Importing the same directory again finds
 * each one by that source and writes nothing; a file changed since is
 * reported and left alone, and one forgotten here is never brought back.
 */

export const MARKDOWN_CONNECTOR = "markdown";

/**
 * Host values key: the folder notes and Claude Code memories already
 * imported, a hash of each one's source pointer to the memory it became, so
 * a re-import finds them and a forgotten one stays forgotten. Hashes and ids
 * only, never a path or a name.
 */
export const IMPORTED_KEY = "transfer.imported";

/** How many file notes a result lists per list. Starting value. */
export const FOLDER_NOTES_SHOWN = 50;

export interface FileNote {
  path: string;
  message: string;
}

export type NoteAction = "create" | "update" | "unchanged" | "forgotten" | "refused";

export interface NoteOutcome {
  path: string;
  action: NoteAction;
  /** The memory's call number, once it has one. */
  call?: string;
  title?: string;
  kind?: string;
  scope?: string;
  /** Why it was refused or left alone. */
  message?: string;
}

/** What one folder read came to, file by file. */
export interface FolderReport {
  /** Markdown files read. */
  files: number;
  /** Files the mirror wrote, read as memories. */
  memories: number;
  /** Files the mirror wrote and nobody changed: left alone. */
  unchanged: number;
  /** Memories taken in: edited files, and memories this library does not hold yet. */
  applied: number;
  conflicts: FileNote[];
  problems: FileNote[];
  /** Memories this library has forgotten, left out. */
  forgotten: FileNote[];
  /** Notes written by hand, or Claude Code memories, and what happens to each. */
  notes: NoteOutcome[];
}

function emptyReport(): FolderReport {
  return { files: 0, memories: 0, unchanged: 0, applied: 0, conflicts: [], problems: [], forgotten: [], notes: [] };
}

/** The report as a result carries it: long lists capped. */
export function shownReport(report: FolderReport): FolderReport {
  return {
    ...report,
    conflicts: report.conflicts.slice(0, FOLDER_NOTES_SHOWN),
    problems: report.problems.slice(0, FOLDER_NOTES_SHOWN),
    forgotten: report.forgotten.slice(0, FOLDER_NOTES_SHOWN),
    notes: report.notes.slice(0, FOLDER_NOTES_SHOWN * 4),
  };
}

function connectorCode(error: unknown): string | null {
  return error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
    ? ((error as { code: string }).code)
    : null;
}

/** What the connector reads in a folder, validated item by item. */
export async function pullFolder(
  ctx: ToolContext,
  op: "read_mirror" | "read_claude_code",
  folder: string,
): Promise<MirrorReadFile[]> {
  const connectors = ctx.ports.connectors;
  if (!connectors) {
    throw new ToolError("unavailable", "This host has no markdown connector, so no folder can be read. Nothing was written.");
  }
  let pulled;
  try {
    pulled = await connectors.pull(MARKDOWN_CONNECTOR, JSON.stringify({ op, folder }));
  } catch (error) {
    const code = connectorCode(error);
    const message = error instanceof Error ? error.message : String(error);
    if (code === "unknown_connector") {
      throw new ToolError("unavailable", "This host has no markdown connector, so no folder can be read. Nothing was written.");
    }
    throw new ToolError("invalid_input", `The folder could not be read: ${message} Nothing was written.`, { reason: code });
  }
  const files: MirrorReadFile[] = [];
  for (const item of pulled.items) {
    const parsed = mirrorReadFileSchema.safeParse(item.payload);
    if (parsed.success) files.push(parsed.data);
  }
  return files;
}

/* ------------------------------------------------------------------ */
/* The imported map in host values                                     */
/* ------------------------------------------------------------------ */

function importedKeyOf(uri: string): string {
  return sha256(`reverie-import:${uri}`).slice(0, 32);
}

async function readImported(ctx: ToolContext): Promise<Record<string, string>> {
  const values = valuesOf(ctx.ports);
  if (!values) return {};
  const value = await values.get(IMPORTED_KEY);
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

async function recordImported(ctx: ToolContext, entries: Record<string, string>): Promise<void> {
  const values = valuesOf(ctx.ports);
  if (!values || Object.keys(entries).length === 0) return;
  if (values.update) {
    await values.update([IMPORTED_KEY], (current) => {
      const before = current[IMPORTED_KEY];
      const base = before && typeof before === "object" && !Array.isArray(before) ? (before as Record<string, unknown>) : {};
      return { [IMPORTED_KEY]: { ...base, ...entries } };
    });
    return;
  }
  await values.set(IMPORTED_KEY, { ...(await readImported(ctx)), ...entries });
}

/** The live memory citing a source with this pointer, if one does. */
async function memoryCiting(ctx: ToolContext, kind: "file" | "import", uri: string) {
  const citation = await ctx.db.memorySource.findFirst({
    where: { source: { kind, uri } },
    select: { memory: { select: { id: true, callNumber: true, title: true, body: true, why: true, howToApply: true, importance: true, state: true, kind: true, trust: true, scope: true } } },
  });
  return citation?.memory ?? null;
}

/* ------------------------------------------------------------------ */
/* Mirror folders                                                      */
/* ------------------------------------------------------------------ */

export interface PreparedMirror {
  snapshot: ExportSnapshot;
  keepSupersededBy: Set<string>;
  report: FolderReport;
  /** Edited files the mirror wrote, taken in: their hash is adopted once the import commits. */
  adopt: Record<string, string>;
  notes: PreparedNote[];
}

type Problem = { path: string; message: string };

const shown = (findings: readonly DisciplineFinding[]) => findings.map((finding) => finding.reason).join(" ");

/** Discipline on one memory read from a file, as an import of a snapshot runs it. */
function disciplineProblem(memory: SnapshotMemory): string | null {
  const verdict = runDiscipline({
    kind: memory.kind,
    title: memory.title,
    body: memory.body,
    why: memory.why,
    howToApply: memory.howToApply,
    sourceTrust: memory.trust,
    // The file cannot carry whether the owner asked for a sensitive memory to be kept.
    explicitAsk: true,
  });
  const findings = [...verdict.findings];
  for (const citation of memory.sources) {
    findings.push(...checkSecrets({ kind: memory.kind, title: "", body: citation.quote, sourceTrust: memory.trust }).findings);
  }
  return findings.length > 0 ? `Discipline refused it: ${shown(findings)}` : null;
}

function trustRank(trust: string): number {
  return TRUST_ORDER.indexOf(trust as TrustTier);
}

/** The library has not changed this memory since its file was written. True when the file carries no revision. */
function revisionMatches(record: MirrorRecord, held: SnapshotMemory, silo: ExportSnapshot, keys: RevisionKeys): boolean {
  return record.revision === null || memoryRevision(held, silo.aliases, keys) === record.revision;
}

export async function prepareMirror(
  ctx: ToolContext,
  files: readonly MirrorReadFile[],
  mode: "merge" | "replace",
): Promise<PreparedMirror> {
  let read: MirrorRead;
  try {
    read = readMirror(files);
  } catch (error) {
    if (error instanceof MirrorManifestError) {
      throw new ToolError("invalid_input", `The mirror's manifest does not read: ${error.message} Nothing was written.`);
    }
    throw error;
  }
  const report = emptyReport();
  report.files = files.filter((file) => file.format === "markdown").length;
  report.memories = read.records.length;
  report.problems.push(...read.problems);
  if (!read.hasManifest && read.records.length > 0) {
    for (const record of read.records) {
      report.problems.push({ path: record.path, message: "The folder has no .reverie/library.json, so this file's shelf cannot be read." });
    }
    read = { ...read, records: [] };
  }
  if (mode === "replace" && !read.hasManifest) {
    throw new ToolError("refused", "A replace takes the library from a mirror folder, and this folder holds no .reverie/library.json. Nothing was written.");
  }

  const silo = await buildExportSnapshot(ctx.db, { now: ctx.now });
  const siloKeys = revisionKeys(silo);
  const siloById = new Map(silo.memories.map((row) => [row.id, row]));
  const siloByCall = new Map(silo.memories.map((row) => [row.callNumber, row.id]));
  const siloAlias = new Map(silo.aliases.map((row) => [row.oldCallNumber, row.memoryId]));
  const forgottenIds = new Set(
    (
      await ctx.db.memoryVersion.findMany({
        where: { operation: "forget", memoryId: { in: read.records.map((record) => record.memory.id) } },
        select: { memoryId: true },
      })
    ).map((row) => row.memoryId),
  );

  const include = new Set<string>();
  const byId = new Map<string, MirrorRecord>();
  const problems: Problem[] = [];
  const now = ctx.now.toISOString();

  for (const record of read.records) {
    const id = record.memory.id;
    byId.set(id, record);
    if (mode === "replace") {
      const problem = disciplineProblem(record.memory);
      if (problem) problems.push({ path: record.path, message: problem });
      else include.add(id);
      continue;
    }

    if (forgottenIds.has(id) || (siloAlias.get(record.memory.callNumber) === null && !siloByCall.has(record.memory.callNumber) && !siloById.has(id))) {
      report.forgotten.push({ path: record.path, message: `${record.memory.callNumber} was forgotten in this library and stays forgotten.` });
      continue;
    }
    const held = siloById.get(id);
    if (held && record.unchanged) {
      report.unchanged += 1;
      continue;
    }
    if (held) {
      if (!revisionMatches(record, held, silo, siloKeys)) {
        report.conflicts.push({
          path: record.path,
          message: `Edited in the folder while ${held.callNumber} also changed in the library. Left alone: export the mirror again and redo the edit.`,
        });
        continue;
      }
      if (trustRank(record.memory.trust) < trustRank(held.trust)) {
        problems.push({ path: record.path, message: `An edit in the folder cannot raise trust from ${held.trust} to ${record.memory.trust}.` });
        continue;
      }
      if (record.memory.kind === "procedure" && held.kind !== "procedure") {
        problems.push({ path: record.path, message: "An edit in the folder cannot turn a memory into a procedure. Use memory.promote_procedure." });
        continue;
      }
      // Recall moves these on its own; the file's older counts never win.
      record.memory = {
        ...record.memory,
        lastRecalledAt: held.lastRecalledAt,
        recallCount: held.recallCount,
        updatedAt: now,
      };
    } else if (record.memory.kind === "procedure" && record.memory.trust === "external") {
      problems.push({ path: record.path, message: "An external source never yields a procedure." });
      continue;
    }
    const holder = siloByCall.get(record.memory.callNumber);
    if (holder !== undefined && holder !== id) {
      problems.push({ path: record.path, message: `${record.memory.callNumber} names another memory in this library.` });
      continue;
    }
    if (holder === undefined && siloAlias.has(record.memory.callNumber) && siloAlias.get(record.memory.callNumber) !== id) {
      problems.push({ path: record.path, message: `${record.memory.callNumber} once named another memory in this library and is never reissued.` });
      continue;
    }
    const takenAlias = record.aliases.find((alias) => {
      const owner = siloAlias.get(alias.oldCallNumber);
      return (owner !== undefined && owner !== id) || (siloByCall.has(alias.oldCallNumber) && siloByCall.get(alias.oldCallNumber) !== id);
    });
    if (takenAlias) {
      problems.push({ path: record.path, message: `Its previous number ${takenAlias.oldCallNumber} belongs to another memory here.` });
      continue;
    }
    const problem = disciplineProblem(record.memory);
    if (problem) {
      problems.push({ path: record.path, message: problem });
      continue;
    }
    include.add(id);
  }

  // Assemble, and drop any file the whole snapshot still refuses, a few rounds at most.
  let assembled = assembleSnapshot(read, { include, retireMissing: mode === "replace" ? { at: now } : false });
  for (let round = 0; ; round += 1) {
    const parsed = snapshotSchema.safeParse(assembled.snapshot);
    if (parsed.success) break;
    const dropped = new Set<string>();
    const elsewhere: string[] = [];
    for (const issue of parsed.error.issues) {
      const [collection, index] = issue.path;
      if (collection === "memories" && typeof index === "number") {
        const memory = assembled.snapshot.memories[index];
        if (memory && !dropped.has(memory.id)) {
          dropped.add(memory.id);
          problems.push({ path: byId.get(memory.id)?.path ?? memory.callNumber, message: issue.message });
        }
      } else {
        elsewhere.push(`${issue.path.join(".")}: ${issue.message}`);
      }
    }
    if (elsewhere.length > 0 || dropped.size === 0 || round >= 4) {
      throw new ToolError("invalid_input", `The folder does not make a library: ${elsewhere.slice(0, 5).join("; ")} Nothing was written.`, {
        issues: elsewhere.slice(0, 20),
      });
    }
    for (const id of dropped) include.delete(id);
    assembled = assembleSnapshot(read, { include, retireMissing: mode === "replace" ? { at: now } : false });
  }

  // History carries no secret either, as for a snapshot.
  for (const version of assembled.snapshot.versions) {
    if (!version.body) continue;
    if (checkSecrets({ kind: "fact", title: "", body: version.body, sourceTrust: "stated" }).findings.length > 0) {
      throw new ToolError("refused", "Nothing was imported. The mirror's version history holds what the secret scan refuses.", {
        version: version.id,
      });
    }
  }

  const snapshot = assembled.snapshot;
  const keepSupersededBy = new Set<string>();
  if (mode === "merge") {
    // The library's own rows stand: a merge from a folder never renames a
    // shelf or recolours a tag back to what the folder last saw.
    const siloSection = new Map(silo.sections.map((row) => [row.code, row]));
    const siloSectionCode = new Map(silo.sections.map((row) => [row.id, row.code]));
    const siloShelf = new Map(silo.shelves.map((row) => [`${siloSectionCode.get(row.sectionId)}/${row.code}`, row]));
    const siloTag = new Map(silo.tags.map((row) => [row.slug, row]));
    const fileSectionCode = new Map(snapshot.sections.map((row) => [row.id, row.code]));
    snapshot.sections = snapshot.sections.map((row) => {
      const held = siloSection.get(row.code);
      return held ? { ...row, name: held.name, order: held.order } : row;
    });
    snapshot.shelves = snapshot.shelves.map((row) => {
      const held = siloShelf.get(`${fileSectionCode.get(row.sectionId)}/${row.code}`);
      return held ? { ...row, name: held.name, description: held.description, order: held.order } : row;
    });
    snapshot.tags = snapshot.tags.map((row) => {
      const held = siloTag.get(row.slug);
      return held ? { ...row, colour: held.colour } : row;
    });
    const siloProjects = new Set(silo.projects.map((row) => row.slug));
    snapshot.projects = snapshot.projects.filter((row) => !siloProjects.has(row.slug));
    // A source no memory in the folder cites is only the library's business on a replace.
    const cited = new Set(snapshot.memories.flatMap((row) => row.sources.map((citation) => citation.sourceId)));
    snapshot.sources = snapshot.sources.filter((row) => cited.has(row.id));
    for (const [memoryId, target] of assembled.danglingSupersededBy) {
      if (siloById.has(target)) keepSupersededBy.add(memoryId);
    }
  }

  report.problems.push(...problems);
  report.applied = snapshot.memories.length;

  const adopt: Record<string, string> = {};
  for (const memory of snapshot.memories) {
    const record = byId.get(memory.id);
    if (record && record.owned && !record.unchanged && record.sha256) adopt[record.path] = record.sha256;
  }

  return { snapshot, keepSupersededBy, report, adopt, notes: await prepareNotes(ctx, read.fresh) };
}

/* ------------------------------------------------------------------ */
/* Notes written by hand in a mirror folder                            */
/* ------------------------------------------------------------------ */

const listOfText = z
  .union([z.array(z.string()), z.string()])
  .optional()
  .transform((value) => (value === undefined ? undefined : Array.isArray(value) ? value : value.split(/[,\s]+/).filter(Boolean)));

const optionalLong = z.string().trim().min(1).max(BODY_MAX_LENGTH).optional();

const noteSchema = z
  .object({
    title: z.string().trim().min(1).max(TITLE_MAX_LENGTH).optional(),
    kind: MemoryKind.optional(),
    shelf: shelfPathSchema.optional(),
    occurredOn: dateOnlySchema.optional(),
    date: dateOnlySchema.optional(),
    project: z.string().trim().min(1).max(64).optional(),
    tags: listOfText,
    importance: z.number().int().min(1).max(5).optional(),
    why: optionalLong,
    howToApply: optionalLong,
    attendees: listOfText,
    occasion: z.string().trim().min(1).max(200).optional(),
    mentions: listOfText,
  })
  .passthrough();

export interface PreparedNote {
  outcome: NoteOutcome;
  /** For a create or an update: what is written. */
  input?: ParsedRememberInput;
  uri?: string;
  memoryId?: string;
  modifiedAt?: string | null;
}

function noteUri(path: string): string {
  return `mirror:${path}`;
}

async function prepareNotes(ctx: ToolContext, fresh: readonly FreshNote[]): Promise<PreparedNote[]> {
  const imported = await readImported(ctx);
  const prepared: PreparedNote[] = [];
  for (const note of fresh) {
    const refuse = (message: string): PreparedNote => ({ outcome: { path: note.path, action: "refused", message } });
    const parsed = noteSchema.safeParse(note.data);
    if (!parsed.success) {
      prepared.push(refuse(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")));
      continue;
    }
    const data = parsed.data;
    const body = note.body.trim();
    if (body.length === 0) {
      prepared.push(refuse("The note has no body."));
      continue;
    }
    if ((data.kind ?? "fact") === "procedure") {
      prepared.push(refuse("A procedure is written only through memory.promote_procedure, with the owner's yes."));
      continue;
    }
    let scopeRef: string | undefined;
    if (data.project) {
      try {
        scopeRef = (await getProject(ctx.db, data.project)).slug;
      } catch {
        prepared.push(refuse(`No project ${data.project} is registered. Register it with memory.set_projects first.`));
        continue;
      }
    }
    const occurredOn = data.occurredOn ?? data.date ?? (note.modifiedAt ? new Date(note.modifiedAt) : ctx.now);
    const input = rememberInputSchema.safeParse({
      body,
      ...(data.title ? { title: data.title } : {}),
      kind: data.kind ?? "fact",
      ...(data.shelf ?? note.folderShelf ? { shelf: data.shelf ?? note.folderShelf } : {}),
      occurredOn: dayKey(occurredOn),
      scope: scopeRef ? "project" : "global",
      ...(scopeRef ? { scopeRef } : {}),
      tags: data.tags ?? [],
      attendees: data.attendees ?? [],
      ...(data.occasion ? { occasion: data.occasion } : {}),
      mentions: data.mentions ?? [],
      ...(data.why ? { why: data.why } : {}),
      ...(data.howToApply ? { howToApply: data.howToApply } : {}),
      ...(data.importance ? { importance: data.importance } : {}),
      // The owner wrote it in their own folder and said yes to the import.
      explicitAsk: true,
    });
    if (!input.success) {
      prepared.push(refuse(input.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")));
      continue;
    }
    const verdict = runDiscipline({
      kind: input.data.kind,
      title: input.data.title ?? body,
      body,
      why: input.data.why ?? null,
      howToApply: input.data.howToApply ?? null,
      sourceTrust: "stated",
      explicitAsk: true,
    });
    if (!verdict.ok) {
      prepared.push(refuse(`Discipline refused it: ${shown(verdict.findings)}`));
      continue;
    }

    const uri = noteUri(note.path);
    const held = await memoryCiting(ctx, "file", uri);
    const base = { path: note.path, kind: input.data.kind, scope: input.data.scope };
    if (held) {
      const same =
        held.body === input.data.body &&
        (input.data.title === undefined || held.title === input.data.title) &&
        (input.data.why === undefined || held.why === input.data.why) &&
        (input.data.howToApply === undefined || held.howToApply === input.data.howToApply);
      if (same) {
        prepared.push({ outcome: { ...base, action: "unchanged", call: held.callNumber, title: held.title } });
      } else if (held.state === "superseded") {
        prepared.push({ outcome: { ...base, action: "refused", call: held.callNumber, message: `${held.callNumber} was superseded and is history.` } });
      } else {
        prepared.push({ outcome: { ...base, action: "update", call: held.callNumber, title: input.data.title ?? held.title }, input: input.data, uri, memoryId: held.id });
      }
      continue;
    }
    if (imported[importedKeyOf(uri)]) {
      prepared.push({ outcome: { ...base, action: "forgotten", message: "Imported once already and forgotten or removed here since. Not brought back." } });
      continue;
    }
    prepared.push({ outcome: { ...base, action: "create", ...(input.data.title ? { title: input.data.title } : {}) }, input: input.data, uri, modifiedAt: note.modifiedAt });
  }
  return prepared;
}

function noteProvenance(uri: string, label: string, quote: string, at: string | null, trust: "stated" | "confirmed"): DraftedProvenance {
  return {
    trust,
    sourceTrust: trust,
    citation: {
      source: {
        kind: trust === "stated" ? "file" : "import",
        uri,
        label: label.slice(0, 200),
        ...(at && !Number.isNaN(Date.parse(at)) ? { occurredAt: at } : {}),
        trust,
      },
      quote: capQuote(quote),
    },
    door: "import",
  };
}

function refusalOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Writes the notes a dry run would create or update. Each one on its own: one refused leaves the rest. */
export async function applyNotes(ctx: ToolContext, notes: PreparedNote[]): Promise<NoteOutcome[]> {
  const importCtx: ToolContext = { ...ctx, actor: "import" };
  const recorded: Record<string, string> = {};
  const outcomes: NoteOutcome[] = [];
  for (const note of notes) {
    if (!note.input || !note.uri) {
      outcomes.push(note.outcome);
      continue;
    }
    try {
      if (note.outcome.action === "update" && note.memoryId) {
        const updated = await updateMemory(
          ctx.db,
          note.memoryId,
          {
            body: note.input.body,
            ...(note.input.title ? { title: note.input.title } : {}),
            ...(note.input.why ? { why: note.input.why } : {}),
            ...(note.input.howToApply ? { howToApply: note.input.howToApply } : {}),
          },
          { actor: "import", at: ctx.now },
        );
        if (updated.changed) {
          ctx.emit("memory.memory.written", {
            memoryId: updated.memory.id,
            call: updated.memory.callNumber,
            door: "import",
            operation: "update",
            kind: updated.memory.kind,
            trust: updated.memory.trust,
          });
        }
        outcomes.push({ ...note.outcome, call: updated.memory.callNumber });
        continue;
      }
      const result = await commitRemember(
        importCtx,
        note.input,
        noteProvenance(note.uri, `markdown note ${note.outcome.path}`, note.input.body, note.modifiedAt ?? null, "stated"),
      );
      recorded[importedKeyOf(note.uri)] = result.memory.id;
      outcomes.push({ ...note.outcome, call: result.memory.call, title: result.memory.title });
    } catch (error) {
      outcomes.push({ ...note.outcome, action: "refused", message: refusalOf(error) });
    }
  }
  await recordImported(ctx, recorded);
  return outcomes;
}

/* ------------------------------------------------------------------ */
/* Claude Code memory directories                                      */
/* ------------------------------------------------------------------ */

export interface PreparedClaudeCode {
  report: FolderReport;
  entries: Array<{ memory: ClaudeCodeMemory; outcome: NoteOutcome; uri: string; existingId?: string }>;
  project: string | null;
}

function claudeCodeUri(project: string | null, name: string): string {
  return `claude-code-memory:${project ?? "global"}/${encodeURIComponent(name)}`;
}

export async function prepareClaudeCode(
  ctx: ToolContext,
  files: readonly MirrorReadFile[],
  projectInput: string | undefined,
): Promise<PreparedClaudeCode> {
  let project: string | null = null;
  if (projectInput) {
    try {
      project = (await getProject(ctx.db, projectInput)).slug;
    } catch {
      throw new ToolError("invalid_input", `No project ${projectInput} is registered. Register it with memory.set_projects, or import without a project. Nothing was written.`);
    }
  }
  const report = emptyReport();
  const indexFile = files.find((file) => file.path.toLowerCase() === CLAUDE_CODE_INDEX.toLowerCase());
  const index = indexFile ? readClaudeCodeIndex(indexFile.body) : new Map<string, string>();
  const imported = await readImported(ctx);
  const entries: PreparedClaudeCode["entries"] = [];
  const seen = new Set<string>();

  for (const file of files) {
    if (file === indexFile || file.format !== "markdown") continue;
    report.files += 1;
    const read = readClaudeCodeMemory(file, index);
    if ("problem" in read) {
      report.problems.push({ path: read.problem.file, message: read.problem.message });
      continue;
    }
    const memory = read.memory;
    if (seen.has(memory.name)) {
      report.problems.push({ path: memory.file, message: `Another file in the directory is also named ${memory.name}. Left out.` });
      continue;
    }
    seen.add(memory.name);
    report.memories += 1;
    const scope = memory.projectScoped && project ? "project" : "global";
    const uri = claudeCodeUri(project, memory.name);
    const base: NoteOutcome = { path: memory.file, action: "create", title: memory.title, kind: memory.kind, scope };

    const held = await memoryCiting(ctx, "import", uri);
    if (held) {
      const changed = held.body !== memory.body;
      entries.push({
        memory,
        uri,
        existingId: held.id,
        outcome: {
          ...base,
          action: "unchanged",
          call: held.callNumber,
          ...(changed ? { message: "Changed in the directory since it was imported. Left alone: the directory is imported once." } : {}),
        },
      });
      report.unchanged += 1;
      continue;
    }
    if (imported[importedKeyOf(uri)]) {
      entries.push({ memory, uri, outcome: { ...base, action: "forgotten", message: "Imported once already and forgotten or removed here since. Not brought back." } });
      report.forgotten.push({ path: memory.file, message: "Forgotten here since it was imported." });
      continue;
    }
    const verdict = runDiscipline({
      kind: memory.kind,
      title: memory.title,
      body: memory.body,
      why: memory.why,
      howToApply: memory.howToApply,
      sourceTrust: "confirmed",
      explicitAsk: true,
    });
    const quoteFindings = checkSecrets({ kind: memory.kind, title: "", body: memory.quote, sourceTrust: "confirmed" }).findings;
    if (!verdict.ok || quoteFindings.length > 0) {
      const message = `Discipline refused it: ${shown([...verdict.findings, ...quoteFindings])}`;
      entries.push({ memory, uri, outcome: { ...base, action: "refused", message } });
      report.problems.push({ path: memory.file, message });
      continue;
    }
    entries.push({ memory, uri, outcome: base });
  }
  report.applied = entries.filter((entry) => entry.outcome.action === "create").length;
  report.notes = entries.map((entry) => entry.outcome);
  return { report, entries, project };
}

/** Writes what prepareClaudeCode planned. Each memory on its own; links once all are in. */
export async function applyClaudeCode(ctx: ToolContext, prepared: PreparedClaudeCode): Promise<{ outcomes: NoteOutcome[]; links: number }> {
  const importCtx: ToolContext = { ...ctx, actor: "import" };
  const recorded: Record<string, string> = {};
  const idByName = new Map<string, string>();
  const outcomes: NoteOutcome[] = [];

  for (const entry of prepared.entries) {
    if (entry.existingId) idByName.set(entry.memory.name, entry.existingId);
    if (entry.outcome.action !== "create") {
      outcomes.push(entry.outcome);
      continue;
    }
    const memory = entry.memory;
    const scope = entry.outcome.scope === "project" && prepared.project ? "project" : "global";
    const occurredOn = memory.modifiedAt && !Number.isNaN(Date.parse(memory.modifiedAt)) ? dayKey(new Date(memory.modifiedAt)) : dayKey(ctx.now);
    const provenance = noteProvenance(entry.uri, `Claude Code memory ${memory.name}`, memory.quote, memory.modifiedAt, "confirmed");
    try {
      let id: string;
      let call: string;
      if (memory.kind === "procedure") {
        // The one kind that only promote_procedure writes, with the yes this import carries.
        const result = (await importCtx.invoke(
          "memory.promote_procedure",
          {
            body: memory.body,
            title: memory.title,
            why: memory.why,
            howToApply: memory.howToApply,
            occurredOn,
            scope,
            ...(scope === "project" ? { scopeRef: prepared.project } : {}),
            sources: [provenance.citation],
            explicitAsk: true,
            confirmedByUser: true,
          },
          { actor: "import" },
        )) as { memory: { id: string; call: string } };
        id = result.memory.id;
        call = result.memory.call;
      } else {
        const input = rememberInputSchema.parse({
          body: memory.body,
          title: memory.title,
          kind: memory.kind,
          occurredOn,
          scope,
          ...(scope === "project" ? { scopeRef: prepared.project } : {}),
          ...(memory.why ? { why: memory.why } : {}),
          ...(memory.howToApply ? { howToApply: memory.howToApply } : {}),
          explicitAsk: true,
        });
        const result = await commitRemember(importCtx, input, provenance);
        id = result.memory.id;
        call = result.memory.call;
      }
      idByName.set(memory.name, id);
      recorded[importedKeyOf(entry.uri)] = id;
      outcomes.push({ ...entry.outcome, call });
    } catch (error) {
      outcomes.push({ ...entry.outcome, action: "refused", message: refusalOf(error) });
    }
  }

  // `[[other-name]]` becomes an elaborates link, for what this import wrote.
  let links = 0;
  for (const entry of prepared.entries) {
    const fromId = idByName.get(entry.memory.name);
    if (!fromId || entry.existingId) continue;
    for (const name of entry.memory.links) {
      const toId = idByName.get(name);
      if (!toId || toId === fromId) continue;
      try {
        await createLink(ctx.db, { fromId, toId, relation: "elaborates" });
        links += 1;
      } catch {
        // Already linked, or the other end is gone: nothing to add.
      }
    }
  }

  await recordImported(ctx, recorded);
  return { outcomes, links };
}
