import type { Prisma, Project } from "../../../generated/prisma/index.js";
import type { MemoryScope } from "../../schemas/enums.js";
import type { ToolContext } from "../registry.js";
import { resolveProject } from "./project.js";

/**
 * What one session may see of scoped memories (docs/SPEC.md section 4,
 * "Scopes"; gate "Scope isolation"): every global memory, the memories scoped
 * to the project the session resolves to, to the agent it names and to the
 * session itself. Never another project's, agent's or session's. A session
 * that resolves to no project sees no project memory at all.
 */

export interface ScopePair {
  scope: MemoryScope;
  scopeRef: string | null;
}

export interface VisibleScopes {
  pairs: ScopePair[];
  project: Project | null;
  /**
   * The narrowest scope the session has, for the RecallLog row: session, then
   * agent, then project, then global. Starting value: the row has one scope
   * column and a recall spans several.
   */
  logScope: ScopePair;
}

export async function visibleScopes(ctx: ToolContext): Promise<VisibleScopes> {
  const project = (await resolveProject(ctx)).project;
  const pairs: ScopePair[] = [{ scope: "global", scopeRef: null }];
  if (project) pairs.push({ scope: "project", scopeRef: project.slug });
  if (ctx.session.agent) pairs.push({ scope: "agent", scopeRef: ctx.session.agent });
  if (ctx.session.id) pairs.push({ scope: "session", scopeRef: ctx.session.id });

  const logScope: ScopePair = ctx.session.id
    ? { scope: "session", scopeRef: ctx.session.id }
    : ctx.session.agent
      ? { scope: "agent", scopeRef: ctx.session.agent }
      : project
        ? { scope: "project", scopeRef: project.slug }
        : { scope: "global", scopeRef: null };

  return { pairs, project, logScope };
}

/** The same visibility as a Prisma filter. */
export function scopeWhere(pairs: readonly ScopePair[]): Prisma.MemoryWhereInput {
  return {
    OR: pairs.map((pair) =>
      pair.scopeRef === null ? { scope: pair.scope, scopeRef: null } : { scope: pair.scope, scopeRef: pair.scopeRef },
    ),
  };
}
