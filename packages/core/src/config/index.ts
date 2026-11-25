import { z } from "zod";

import { MemoryKind } from "../schemas/enums.js";

/**
 * The module's config, as docs/SPEC.md section 17 declares it. The host stores
 * the values and hands them over through the settings port; core owns the shape
 * and the defaults, and config.schema.json at the repo root mirrors this file.
 *
 * Every figure is a starting value to tune against the eval corpus (section
 * 16). The ranges are the ones config.schema.json declares.
 *
 * Nothing is cached from any of these values. Changing a half life needs no
 * recompute; changing the embedding model re-embeds every memory before the
 * new value counts as applied (section 17, the re-embed hook), which is the
 * host's to run.
 */

const halfLife = (fallback: number) => z.number().min(7).max(3650).default(fallback);

/**
 * Recency half life per kind, in days, counted from lastConfirmedAt.
 * `procedure` is absent on purpose: its recency is always 1.
 */
export const halfLifeDaysSchema = z
  .object({
    fact: halfLife(365),
    preference: halfLife(730),
    episode: halfLife(90),
    reference: halfLife(365),
  })
  .strict();

export const recallConfigSchema = z
  .object({
    /** Below this score an item is dropped. Nothing above it means sufficient: false. */
    floor: z.number().min(0).max(1).default(0.35),
    /** The most items one recall returns. */
    maxItems: z.number().int().min(1).max(50).default(8),
    /** The most tokens one recall returns. Whichever limit is hit first stops the pack. */
    tokenBudget: z.number().int().min(100).max(20000).default(1200),
  })
  .strict();

/** The kinds auto accept may apply to. A procedure never auto accepts. */
export const AutoAcceptKind = MemoryKind.exclude(["procedure"]);
export type AutoAcceptKind = z.infer<typeof AutoAcceptKind>;

export const autoAcceptConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    kinds: z.array(AutoAcceptKind).default(["fact", "episode"]),
    afterDays: z.number().int().min(1).max(90).default(7),
  })
  .strict();

export const embeddingConfigSchema = z
  .object({
    /** Null means full text search only. */
    model: z.string().nullable().default(null),
    dim: z.number().int().nullable().default(null),
  })
  .strict();

export const consolidateEveryConfigSchema = z
  .object({
    sessions: z.number().int().min(1).default(10),
    days: z.number().int().min(1).default(7),
  })
  .strict();

/** Section code, a slash, shelf code: `DSK/RET`. */
export const SHELF_PATH_PATTERN = /^[A-Z]{3}\/[A-Z]{3,4}$/;

export const moduleConfigSchema = z
  .object({
    halfLifeDays: halfLifeDaysSchema.default({}),
    recall: recallConfigSchema.default({}),
    /** Ceiling on the always in context core block. */
    coreTokenCap: z.number().int().min(100).max(8000).default(800),
    /** Where an entry with no shelf lands: Returns, at the front desk. */
    defaultShelf: z
      .string()
      .regex(SHELF_PATH_PATTERN, "Expected a shelf path such as DSK/RET")
      .default("DSK/RET"),
    /** When a SessionNote expires. */
    sessionNoteTtlHours: z.number().int().min(1).max(720).default(72),
    /** When an active entry with no new confirmation shows on the stale list. */
    staleAfterDays: z.number().int().min(7).max(3650).default(180),
    autoAccept: autoAcceptConfigSchema.default({}),
    embedding: embeddingConfigSchema.default({}),
    consolidateEvery: consolidateEveryConfigSchema.default({}),
    /** The pause switch (section 7). */
    incognito: z.boolean().default(false),
  })
  .strict();

export type ModuleConfig = z.infer<typeof moduleConfigSchema>;
export type ModuleConfigInput = z.input<typeof moduleConfigSchema>;
export type HalfLifeDays = ModuleConfig["halfLifeDays"];
export type RecallConfig = ModuleConfig["recall"];

/** Every default, as one object. */
export const DEFAULT_CONFIG: ModuleConfig = moduleConfigSchema.parse({});

/** A partial config: any key at any depth may be left out. Arrays replace whole. */
export type ConfigPatch = {
  [K in keyof ModuleConfig]?: ModuleConfig[K] extends readonly unknown[]
    ? ModuleConfig[K]
    : ModuleConfig[K] extends Record<string, unknown>
      ? { [J in keyof ModuleConfig[K]]?: ModuleConfig[K][J] }
      : ModuleConfig[K];
};

/**
 * Validates a stored or hand edited config and fills every missing key with
 * its default. Throws a ZodError on an unknown key or an out of range value,
 * so a typo never silently becomes a default.
 */
export function parseConfig(input: unknown): ModuleConfig {
  return moduleConfigSchema.parse(input ?? {});
}

/** As parseConfig, without throwing. */
export function safeParseConfig(input: unknown): z.SafeParseReturnType<unknown, ModuleConfig> {
  return moduleConfigSchema.safeParse(input ?? {});
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const current = merged[key];
    merged[key] = isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value;
  }
  return merged;
}

/**
 * Applies a partial change on top of a full config and validates the result.
 * Nested objects merge key by key; arrays and scalars replace. An undefined
 * value in the patch leaves the base value alone.
 */
export function mergeConfig(base: ModuleConfig, patch: ConfigPatch | Record<string, unknown>): ModuleConfig {
  return moduleConfigSchema.parse(deepMerge(base as Record<string, unknown>, patch as Record<string, unknown>));
}
