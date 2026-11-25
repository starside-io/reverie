import { z } from "zod";

import { codeSchema } from "./common.js";

/** A section: a three letter code and a name. docs/SPEC.md section 5. */
export const sectionCreateSchema = z.object({
  code: codeSchema,
  name: z.string().trim().min(1, "A name is required").max(80),
  /** Position in the building. Defaults to after the last section. */
  order: z.number().int().min(0).optional(),
});

/** Renaming changes the name, never the code. */
export const sectionRenameSchema = z.object({
  name: z.string().trim().min(1, "A name is required").max(80),
});

export type SectionCreateInput = z.input<typeof sectionCreateSchema>;
export type SectionRenameInput = z.input<typeof sectionRenameSchema>;
