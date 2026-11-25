import type { Project } from "../../../generated/prisma/index.js";
import type { Db } from "../../domain/db.js";
import type { LocalPath, LocalPathsPort } from "../../ports.js";
import { normaliseRepoUrl } from "../../schemas/project.js";
import type { SessionInfo, ToolContext } from "../registry.js";

/**
 * Which project a session is working in. docs/SPEC.md section 4,
 * "Identifying the project at run time", in order, stopping at the first hit:
 *
 * 1. The longest registered local path that is a prefix of the session folder.
 * 2. The git remote, normalised, equal to a project's repoUrl. On a hit the
 *    folder is offered as a new local path for that project.
 * 3. No project: the session is global.
 *
 * An unregistered folder is never guessed into a project by name. Archived
 * projects are skipped at both steps: an archived project is not where
 * anything is being worked on. Starting value.
 */

export type ProjectResolution =
  | { via: "path"; project: Project; path: string; offerPath: null }
  | {
      via: "remote";
      project: Project;
      /** The session folder, to offer as a new local path, when it is not registered yet. */
      offerPath: string | null;
    }
  | { via: "none"; project: null; offerPath: null };

/**
 * An absolute folder without trailing separators, backslashes read as
 * slashes. Null for a relative or empty path: a relative path names a
 * different folder in every process.
 */
export function normaliseFolder(path: string | null | undefined): string | null {
  if (typeof path !== "string") return null;
  let value = path.trim().replace(/\\/g, "/");
  if (value.length === 0) return null;
  const absolute = value.startsWith("/") || /^[A-Za-z]:\//.test(value);
  if (!absolute) return null;
  value = value.replace(/\/{2,}/g, "/");
  while (value.length > 1 && value.endsWith("/") && !/^[A-Za-z]:\/$/.test(value)) value = value.slice(0, -1);
  return value;
}

/** True when `folder` is `root` or inside it, on a whole path segment. */
export function isWithin(root: string, folder: string): boolean {
  if (folder === root) return true;
  const base = root.endsWith("/") ? root : `${root}/`;
  return folder.startsWith(base);
}

/** The registered path holding `folder` with the longest match, or null. */
export function longestPathMatch(paths: readonly LocalPath[], folder: string | null): LocalPath | null {
  const target = normaliseFolder(folder);
  if (target === null) return null;
  let best: { entry: LocalPath; length: number } | null = null;
  for (const entry of paths) {
    const root = normaliseFolder(entry.path);
    if (root === null || !isWithin(root, target)) continue;
    if (best === null || root.length > best.length) best = { entry, length: root.length };
  }
  return best?.entry ?? null;
}

/** The resolution itself, with every input passed in. For a caller outside a tool call. */
export async function resolveProjectFor(
  db: Db,
  session: SessionInfo,
  localPaths: LocalPathsPort | undefined,
): Promise<ProjectResolution> {
  const folder = normaliseFolder(session.folder);
  const paths = localPaths && folder !== null ? await localPaths.list() : [];

  if (folder !== null) {
    // Longest first, falling through a path whose project is gone or archived.
    const candidates = paths
      .map((entry) => ({ entry, root: normaliseFolder(entry.path) }))
      .filter((c): c is { entry: LocalPath; root: string } => c.root !== null && isWithin(c.root, folder))
      .sort((a, b) => b.root.length - a.root.length);
    for (const { entry, root } of candidates) {
      const project = await db.project.findUnique({ where: { slug: entry.project } });
      if (project && !project.archived) return { via: "path", project, path: root, offerPath: null };
    }
  }

  const remote = session.gitRemote ? normaliseRepoUrl(session.gitRemote) : null;
  if (remote !== null) {
    const project = await db.project.findUnique({ where: { repoUrl: remote } });
    if (project && !project.archived) {
      const registered = folder !== null && paths.some((entry) => normaliseFolder(entry.path) === folder);
      return { via: "remote", project, offerPath: folder !== null && !registered ? folder : null };
    }
  }

  return { via: "none", project: null, offerPath: null };
}

/** The project this call's session is working in. */
export async function resolveProject(ctx: ToolContext): Promise<ProjectResolution> {
  return resolveProjectFor(ctx.db, ctx.session, ctx.ports.settings.localPaths);
}
