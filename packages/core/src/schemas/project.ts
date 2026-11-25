import { z } from "zod";

import { normaliseTagSlug, tagSlugSchema } from "./tag.js";
import { shelfRefSchema } from "./shelf.js";

/**
 * A repository normalised to `github.com/owner/name`: no scheme, no user, no
 * `.git`, no trailing slash, lowercase host. Accepts https, ssh and scp forms
 * (`git@github.com:owner/name.git`). Returns null for anything that is not a
 * host and an owner/name path.
 */
export function normaliseRepoUrl(input: string): string | null {
  let value = input.trim();
  if (value.length === 0) return null;

  const scp = /^[^@\s/]+@([^:\s/]+):(.+)$/.exec(value);
  if (scp) {
    value = `${scp[1]}/${scp[2]}`;
  } else {
    value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/^[^@/]+@/, "");
  }

  value = value.replace(/\/+$/, "").replace(/\.git$/i, "");
  const parts = value.split("/").filter((part) => part.length > 0);
  if (parts.length !== 3) return null;
  const [host, owner, name] = parts as [string, string, string];
  const hostName = host.toLowerCase().replace(/:\d+$/, "");
  if (!/^[a-z0-9.-]+\.[a-z]+$/.test(hostName)) return null;
  return `${hostName}/${owner}/${name}`;
}

export const repoUrlSchema = z.string().transform((value, ctx) => {
  const normalised = normaliseRepoUrl(value);
  if (normalised === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Expected a repository such as github.com/owner/name",
    });
    return z.NEVER;
  }
  return normalised;
});

/** A project slug follows the tag rule: the project's tag is usually its slug. */
export const projectSlugSchema = z.string().transform((value, ctx) => {
  const slug = normaliseTagSlug(value);
  if (slug === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Expected a short lowercase slug such as nightstash",
    });
    return z.NEVER;
  }
  return slug;
});

/** A project in the registry. Local folder paths are the host's, never here. */
export const projectCreateSchema = z.object({
  slug: projectSlugSchema,
  name: z.string().trim().min(1, "A name is required").max(120),
  repoUrl: repoUrlSchema.optional(),
  shelf: shelfRefSchema.optional(),
  tag: tagSlugSchema.optional(),
  description: z.string().trim().min(1).max(300).optional(),
});

export const projectUpdateSchema = projectCreateSchema
  .omit({ slug: true })
  .partial()
  .extend({ archived: z.boolean().optional() });

export type ProjectCreateInput = z.input<typeof projectCreateSchema>;
export type ProjectUpdateInput = z.input<typeof projectUpdateSchema>;
