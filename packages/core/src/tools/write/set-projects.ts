// memory.set_projects. docs/SPEC.md section 15, "Write, 13" table, row
// `memory.set_projects`; section 4, "Projects" (the registry; local paths are
// the host's, not the silo's; a folder belongs to at most one project; each
// new project gets a shelf and a tag, proposed and shown before they are
// made); section 11, `Project`; section 12 (settings port); gate "Paths stay
// home"; guardrail 9.

import { z } from "zod";

import {
  createProject,
  getProject,
  projectView,
  proposeProjectHome,
  updateProject,
  type ProjectHomeProposal,
  type ProjectView,
} from "../../domain/projects.js";
import type { LocalPathsPort } from "../../ports.js";
import { codeSchema } from "../../schemas/common.js";
import { projectSlugSchema } from "../../schemas/project.js";
import { shelfPathSchema } from "../../schemas/shelf.js";
import { tagSlugSchema } from "../../schemas/tag.js";
import { defineTool, ToolError, type ToolContext } from "../registry.js";
import { normaliseFolder } from "../shared/project.js";

const NAME_MAX = 120;
const DESCRIPTION_MAX = 300;
const REPO_MAX = 500;
const PATH_MAX = 4096;

const name = z.string().trim().min(1, "A name is required").max(NAME_MAX);
const description = z.string().trim().max(DESCRIPTION_MAX);
/** Any form of the repository: https, ssh or scp. Stored as github.com/owner/name. */
const repo = z.string().trim().min(1).max(REPO_MAX);
const folder = z.string().trim().min(1).max(PATH_MAX);

const newShelfSchema = z.object({
  section: codeSchema,
  code: codeSchema,
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(500),
});

export const setProjectsInputSchema = z.discriminatedUnion("action", [
  /** The shelf and tag a new project would get. Writes nothing. */
  z.object({
    action: z.literal("propose"),
    slug: projectSlugSchema,
    name,
    description: description.optional(),
    /** The section the shelf goes in. Defaults to Work. */
    section: codeSchema.optional(),
  }),
  z.object({
    action: z.literal("create"),
    slug: projectSlugSchema,
    name,
    repoUrl: repo.optional(),
    description: description.optional(),
    /**
     * An existing shelf, "WRK/NST", or null for none. Left out, together with
     * newShelf, the proposed shelf is used: made when it does not exist.
     */
    shelf: shelfPathSchema.nullable().optional(),
    /** A shelf to make for it. */
    newShelf: newShelfSchema.optional(),
    /** The project's tag, made when new, or null for none. Defaults to the slug. */
    tag: tagSlugSchema.nullable().optional(),
    /** Folders on this machine that are this project. Written to the host, never the silo. */
    folders: z.array(folder).max(50).default([]),
  }),
  z.object({ action: z.literal("rename"), slug: projectSlugSchema, name }),
  z.object({
    action: z.literal("set"),
    slug: projectSlugSchema,
    /** Null clears it. */
    repoUrl: repo.nullable().optional(),
    shelf: shelfPathSchema.nullable().optional(),
    tag: tagSlugSchema.nullable().optional(),
    description: description.nullable().optional(),
  }),
  z.object({
    action: z.literal("archive"),
    slug: projectSlugSchema,
    /** False brings it back. */
    archived: z.boolean().default(true),
  }),
  z.object({ action: z.literal("add_folder"), slug: projectSlugSchema, path: folder }),
  z.object({ action: z.literal("remove_folder"), path: folder }),
]);

export type SetProjectsInput = z.input<typeof setProjectsInputSchema>;

export interface SetProjectsResult {
  action: SetProjectsInput["action"];
  project: ProjectView | null;
  /** For propose: what create would make. */
  proposal: ProjectHomeProposal | null;
  /** What this call made beside the project row. */
  created: { shelf: string | null; tag: string | null };
  /** The project's folders on this machine, from the host. Null when the host keeps none. */
  folders: string[] | null;
  /** False when nothing needed changing. */
  changed: boolean;
}

const NO_FOLDERS_MESSAGE =
  "This host keeps no project folders (the settings port has no localPaths), so folders cannot be added or removed here. Everything else about the project works without them.";

function localPathsOf(ctx: ToolContext): LocalPathsPort {
  const port = ctx.ports.settings.localPaths;
  if (!port) throw new ToolError("unavailable", NO_FOLDERS_MESSAGE, { localPaths: false });
  return port;
}

function cleanFolder(path: string): string {
  const normalised = normaliseFolder(path);
  if (normalised === null) {
    throw new ToolError("invalid_input", "A project folder is an absolute path on this machine.");
  }
  return normalised;
}

async function foldersOf(ctx: ToolContext, slug: string): Promise<string[] | null> {
  const port = ctx.ports.settings.localPaths;
  if (!port) return null;
  return (await port.list(slug)).map((entry) => entry.path).sort();
}

/** Refuses a folder another project holds, before anything is written. */
async function assertFoldersFree(port: LocalPathsPort, slug: string, folders: string[]): Promise<void> {
  const held = await port.list();
  for (const path of folders) {
    const holder = held.find((entry) => normaliseFolder(entry.path) === path);
    if (holder && holder.project !== slug) {
      throw new ToolError("conflict", `That folder already belongs to ${holder.project}. A folder belongs to at most one project.`, {
        heldBy: holder.project,
      });
    }
  }
}

export const tool = defineTool({
  name: "memory.set_projects",
  title: "Set projects",
  kind: "write",
  summary:
    "The project registry. propose shows the shelf and tag a new project would get, writing nothing. create records a project with its repository (stored as github.com/owner/name), its shelf and tag (the proposed ones unless told otherwise) and optional folders. rename, set (repository, shelf, tag, description; null clears) and archive change one. add_folder and remove_folder register the folders on this machine that are the project; folder paths go to the host, never the silo, and a folder belongs to at most one project.",
  input: setProjectsInputSchema,
  async handler(ctx, input): Promise<SetProjectsResult> {
    const base: SetProjectsResult = {
      action: input.action,
      project: null,
      proposal: null,
      created: { shelf: null, tag: null },
      folders: null,
      changed: false,
    };

    switch (input.action) {
      case "propose": {
        const proposal = await proposeProjectHome(
          ctx.db,
          { slug: input.slug, name: input.name, description: input.description ?? null },
          input.section,
        );
        return { ...base, proposal };
      }

      case "create": {
        const folders = [...new Set(input.folders.map(cleanFolder))];
        let port: LocalPathsPort | null = null;
        if (folders.length > 0) {
          port = localPathsOf(ctx);
          await assertFoldersFree(port, input.slug, folders);
        }

        let shelf = input.shelf;
        let newShelf = input.newShelf;
        if (shelf === undefined && newShelf === undefined) {
          const proposal = await proposeProjectHome(ctx.db, {
            slug: input.slug,
            name: input.name,
            description: input.description ?? null,
          });
          shelf = proposal.shelf?.existing ?? null;
          newShelf = proposal.shelf?.create ?? undefined;
        }
        const tag = input.tag === undefined ? input.slug : input.tag;
        const tagIsNew = tag !== null && !(await ctx.db.tag.findUnique({ where: { slug: tag }, select: { id: true } }));

        const row = await createProject(ctx.db, {
          slug: input.slug,
          name: input.name,
          repoUrl: input.repoUrl ?? null,
          description: input.description ?? null,
          ...(shelf ? { shelf } : {}),
          ...(newShelf ? { newShelf } : {}),
          tag,
        });

        if (port) {
          for (const path of folders) {
            const added = await port.add(row.slug, path);
            if (!added.added && added.heldBy !== row.slug) {
              throw new ToolError("conflict", `That folder already belongs to ${added.heldBy}.`, { heldBy: added.heldBy });
            }
          }
        }

        return {
          ...base,
          project: projectView(row),
          created: {
            shelf: row.createdShelf ? `${row.createdShelf.section.code}/${row.createdShelf.code}` : null,
            tag: tagIsNew ? tag : null,
          },
          folders: await foldersOf(ctx, row.slug),
          changed: true,
        };
      }

      case "rename":
      case "set":
      case "archive": {
        const patch =
          input.action === "rename"
            ? { name: input.name }
            : input.action === "archive"
              ? { archived: input.archived }
              : {
                  ...(input.repoUrl !== undefined ? { repoUrl: input.repoUrl } : {}),
                  ...(input.shelf !== undefined ? { shelf: input.shelf } : {}),
                  ...(input.tag !== undefined ? { tag: input.tag } : {}),
                  ...(input.description !== undefined ? { description: input.description } : {}),
                };
        if (input.action === "set" && Object.keys(patch).length === 0) {
          throw new ToolError("invalid_input", "Nothing to set: give a repoUrl, shelf, tag or description.");
        }
        const tagIsNew =
          "tag" in patch && typeof patch.tag === "string"
            ? !(await ctx.db.tag.findUnique({ where: { slug: patch.tag }, select: { id: true } }))
            : false;
        const { project, changed } = await updateProject(ctx.db, input.slug, patch);
        return {
          ...base,
          project: projectView(project),
          created: { shelf: null, tag: tagIsNew && "tag" in patch ? (patch.tag as string) : null },
          folders: await foldersOf(ctx, project.slug),
          changed,
        };
      }

      case "add_folder": {
        const port = localPathsOf(ctx);
        const path = cleanFolder(input.path);
        const project = await getProject(ctx.db, input.slug);
        const added = await port.add(project.slug, path);
        if (!added.added && added.heldBy !== project.slug) {
          throw new ToolError(
            "conflict",
            `That folder already belongs to ${added.heldBy}. A folder belongs to at most one project: remove it there first.`,
            { heldBy: added.heldBy },
          );
        }
        return {
          ...base,
          project: projectView(project),
          folders: await foldersOf(ctx, project.slug),
          changed: added.added,
        };
      }

      case "remove_folder": {
        const port = localPathsOf(ctx);
        const path = cleanFolder(input.path);
        const holder = (await port.list()).find((entry) => normaliseFolder(entry.path) === path);
        const removed = await port.remove(path);
        if (!removed) throw new ToolError("not_found", "That folder is not registered to any project.");
        const project = holder ? await ctx.db.project.findUnique({ where: { slug: holder.project }, include: { shelf: { include: { section: true } }, tag: true } }) : null;
        return {
          ...base,
          project: project ? projectView(project) : null,
          folders: project ? await foldersOf(ctx, project.slug) : null,
          changed: true,
        };
      }
    }
  },
});
