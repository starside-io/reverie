// memory.projects. docs/SPEC.md section 15, "Read, 18" table, row
// `memory.projects`; section 4, "Projects" (local paths come from the
// settings port, never the silo) and "Identifying the project at run time".

import { z } from "zod";

import { defineTool } from "../registry.js";
import { normaliseFolder, resolveProject } from "../shared/project.js";

export interface ProjectEntry {
  slug: string;
  name: string;
  /** Normalised: github.com/owner/name. */
  repoUrl: string | null;
  /** "WRK/NST", or null when it has none. */
  shelf: string | null;
  /** The project's tag slug, or null. */
  tag: string | null;
  description: string | null;
  archived: boolean;
  /**
   * Entries on the project's shelf or scoped to the project, counted once,
   * whatever their state. Starting reading.
   */
  memoryCount: number;
  /** Folders on this machine, from the host. Empty when the host keeps none. */
  localPaths: string[];
}

export interface ProjectsResult {
  /** By slug. */
  projects: ProjectEntry[];
  /** The project this call's session resolves to, and how. */
  current: { slug: string; via: "path" | "remote" } | null;
  /** False when the host has no local paths port: folders are then never listed. */
  localPathsAvailable: boolean;
}

export const tool = defineTool({
  name: "memory.projects",
  title: "Projects",
  kind: "read",
  summary:
    "The project registry: slug, name, repository, shelf, tag, memory count, and the local folders registered on this machine (from the host, never the silo). Says which project the session resolves to.",
  input: z.object({}),
  async handler(ctx): Promise<ProjectsResult> {
    const port = ctx.ports.settings.localPaths;
    const [projects, paths, resolution] = await Promise.all([
      ctx.db.project.findMany({
        orderBy: { slug: "asc" },
        include: { shelf: { include: { section: true } }, tag: true },
      }),
      port ? port.list() : Promise.resolve([]),
      resolveProject(ctx),
    ]);

    const entries: ProjectEntry[] = [];
    for (const project of projects) {
      const memoryCount = await ctx.db.memory.count({
        where: {
          OR: [
            { scope: "project", scopeRef: project.slug },
            ...(project.shelfId ? [{ shelfId: project.shelfId }] : []),
          ],
        },
      });
      entries.push({
        slug: project.slug,
        name: project.name,
        repoUrl: project.repoUrl,
        shelf: project.shelf ? `${project.shelf.section.code}/${project.shelf.code}` : null,
        tag: project.tag?.slug ?? null,
        description: project.description,
        archived: project.archived,
        memoryCount,
        localPaths: paths
          .filter((entry) => entry.project === project.slug)
          .map((entry) => normaliseFolder(entry.path) ?? entry.path)
          .sort(),
      });
    }

    return {
      projects: entries,
      current: resolution.project ? { slug: resolution.project.slug, via: resolution.via as "path" | "remote" } : null,
      localPathsAvailable: port !== undefined,
    };
  },
});
