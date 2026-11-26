// memory.export. docs/SPEC.md section 15, "Read, 18" table, row
// `memory.export`; section 16, gates "Forget is real" (a forgotten memory is
// absent) and "Paths stay home" (no local folder path, ever: the snapshot
// has no field for one, and this tool never reads the host's folders);
// section 19, "The markdown mirror".
//
// From M7 it also writes the library as a markdown mirror folder, through
// the markdown connector: core builds the documents (domain/transfer/
// mirror.ts), the connector writes them and owns what lands on disk. Core
// touches no path itself.

import { z } from "zod";

import { buildExportSnapshot } from "../../domain/transfer/export.js";
import { buildMirror } from "../../domain/transfer/mirror.js";
import type { ExportSnapshot } from "../../domain/transfer/snapshot.js";
import { defineTool, ToolError } from "../registry.js";
import { MARKDOWN_CONNECTOR } from "../shared/folder-import.js";

/** What the markdown connector reports after writing a mirror. */
export interface MirrorWriteReport {
  /** Files written or rewritten. */
  written: number;
  /** Files already as they should be: not touched. */
  unchanged: number;
  /** Files the mirror wrote before for memories since forgotten, moved or renamed: deleted. */
  removed: number;
  /** Files the mirror left alone, each with the reason: a note of the owner's at that path, or an edit not imported yet. */
  kept: Array<{ path: string; reason: string }>;
}

/** The snapshot, the default: what memory.export has always returned. */
export interface ExportResult {
  snapshot: ExportSnapshot;
  /** Counts, so the audit line says how big the export was. */
  memories: number;
  versions: number;
}

/** With `to: markdown`: the mirror written, and what the connector did. */
export interface MirrorExportResult {
  to: "markdown";
  memories: number;
  /** Versions in the mirror: those of the memories in it. */
  versions: number;
  /** Files in the mirror: one per memory and the manifest. */
  files: number;
  mirror: MirrorWriteReport;
}

const reportSchema = z.object({
  written: z.number().int().min(0).default(0),
  unchanged: z.number().int().min(0).default(0),
  removed: z.number().int().min(0).default(0),
  kept: z.array(z.object({ path: z.string(), reason: z.string() })).default([]),
});

export const exportInputSchema = z.object({
  /** A snapshot in the result (the default), or a markdown mirror written to `folder`. */
  to: z.enum(["snapshot", "markdown"]).default("snapshot"),
  /** For `to: markdown`: the mirror folder, an absolute path on the host. */
  folder: z.string().trim().min(1).max(4096).optional(),
});

export const tool = defineTool({
  name: "memory.export",
  title: "Export",
  kind: "read",
  summary:
    "The full snapshot, for the owner's own backup: sections, shelves, projects, tags, sources, memories, versions, aliases and links. With to: markdown and a folder, writes the library as a markdown mirror there instead: one folder per section, one per shelf, one file per memory, and .reverie/library.json; files the mirror did not write are never touched. Never holds a local folder path, a vector, a session note, the recall log or anything forgotten.",
  input: exportInputSchema,
  async handler(ctx, input): Promise<ExportResult | MirrorExportResult> {
    const snapshot = await buildExportSnapshot(ctx.db, { now: ctx.now });
    if (input.to === "snapshot") {
      return { snapshot, memories: snapshot.memories.length, versions: snapshot.versions.length };
    }

    if (!input.folder) throw new ToolError("invalid_input", "Pass the mirror folder, as an absolute path on this machine.");
    const push = ctx.ports.connectors?.push;
    if (!push) {
      throw new ToolError("unavailable", "This host has no markdown connector that writes, so no mirror can be written.");
    }
    const documents = buildMirror(snapshot);
    // A file the mirror once wrote for a memory forgotten since goes, edited or not: ids only.
    const forgotten = (
      await ctx.db.memoryVersion.findMany({ where: { operation: "forget" }, select: { memoryId: true }, distinct: ["memoryId"] })
    ).map((row) => row.memoryId);
    let raw: unknown;
    try {
      raw = await push.call(ctx.ports.connectors, MARKDOWN_CONNECTOR, {
        op: "write_mirror",
        folder: input.folder,
        documents,
        forgotten,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ToolError("invalid_input", `The mirror could not be written: ${message}`);
    }
    const mirror = reportSchema.parse(raw ?? {});
    const live = new Set(snapshot.memories.map((memory) => memory.id));
    return {
      to: "markdown",
      memories: snapshot.memories.length,
      versions: snapshot.versions.filter((version) => live.has(version.memoryId)).length,
      files: documents.length,
      mirror,
    };
  },
});
