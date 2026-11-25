// memory.export. docs/SPEC.md section 15, "Read, 18" table, row
// `memory.export`; section 16, gates "Forget is real" (a forgotten memory is
// absent) and "Paths stay home" (no local folder path, ever: the snapshot
// has no field for one, and this tool never reads the host's folders).

import { z } from "zod";

import { buildExportSnapshot } from "../../domain/transfer/export.js";
import type { ExportSnapshot } from "../../domain/transfer/snapshot.js";
import { defineTool } from "../registry.js";

export interface ExportResult {
  snapshot: ExportSnapshot;
  /** Counts, so the audit line says how big the export was. */
  memories: number;
  versions: number;
}

export const tool = defineTool({
  name: "memory.export",
  title: "Export",
  kind: "read",
  summary:
    "The full snapshot, for the owner's own backup: sections, shelves, projects, tags, sources, memories, versions, aliases and links. Never holds a local folder path, a vector, a session note or the recall log.",
  input: z.object({}),
  async handler(ctx): Promise<ExportResult> {
    const snapshot = await buildExportSnapshot(ctx.db, { now: ctx.now });
    return { snapshot, memories: snapshot.memories.length, versions: snapshot.versions.length };
  },
});
