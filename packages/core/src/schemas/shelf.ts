import { z } from "zod";

import { codeSchema, idSchema } from "./common.js";

/**
 * A shelf named by its codes, "WRK/NST", or by its id. The path form is what a
 * model quotes back; the id form is what the UI holds.
 */
export const shelfPathSchema = z
  .string()
  .trim()
  .regex(/^[A-Z]{3}\/[A-Z]{3}$/, "Expected a shelf as SECTION/SHELF, such as WRK/NST");

export const shelfRefSchema = z.union([
  shelfPathSchema,
  z.object({ id: idSchema }),
  z.object({ section: codeSchema, shelf: codeSchema }),
]);

export const shelfCreateSchema = z.object({
  /** The section code the shelf goes in. */
  section: codeSchema,
  code: codeSchema,
  name: z.string().trim().min(1, "A name is required").max(80),
  /** Written for the drafter: it decides where a new memory goes. */
  description: z.string().trim().min(1, "A description is required").max(500),
  /** Position within the section. Defaults to after the last shelf. */
  order: z.number().int().min(0).optional(),
});

/** Renaming changes the name (and, if given, the description), never the code. */
export const shelfRenameSchema = z.object({
  name: z.string().trim().min(1, "A name is required").max(80),
  description: z.string().trim().min(1).max(500).optional(),
});

export type ShelfRef = z.input<typeof shelfRefSchema>;
export type ShelfCreateInput = z.input<typeof shelfCreateSchema>;
export type ShelfRenameInput = z.input<typeof shelfRenameSchema>;
