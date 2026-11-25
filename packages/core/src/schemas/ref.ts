import { z } from "zod";

import { RefRole } from "./enums.js";

/**
 * `module://people/person/<id>` or `module://people/event/<id>`. Kept general
 * (any module, any kind) because the other side is another module's to name.
 */
export const MODULE_URI_PATTERN = /^module:\/\/[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*\/[^\s/]+$/;

export const moduleUriSchema = z
  .string()
  .trim()
  .regex(MODULE_URI_PATTERN, "Expected a module URI such as module://people/person/<id>");

/**
 * How a memory points into the people module. With no uri the reference is an
 * unresolved name: the label holds the name as told, and nothing is invented
 * (guardrail 7). `resolved` is derived from the uri, never passed.
 */
export const refInputSchema = z
  .object({
    role: RefRole,
    uri: moduleUriSchema.optional(),
    /** The name as told, or the label the refs port returned. */
    label: z.string().trim().min(1, "A label is required").max(200),
  })
  .transform((value) => ({
    role: value.role,
    uri: value.uri ?? null,
    label: value.label,
    resolved: value.uri !== undefined,
  }));

export type RefInput = z.input<typeof refInputSchema>;
export type ParsedRef = z.output<typeof refInputSchema>;
