import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  DEFAULT_CONFIG,
  mergeConfig,
  moduleConfigSchema,
  parseConfig,
  safeParseConfig,
} from "../../src/config/index.js";

// The defaults, transcribed from docs/SPEC.md section 17.
const SPEC_DEFAULTS = {
  halfLifeDays: { fact: 365, preference: 730, episode: 90, reference: 365 },
  recall: { floor: 0.35, maxItems: 8, tokenBudget: 1200 },
  coreTokenCap: 800,
  defaultShelf: "DSK/RET",
  sessionNoteTtlHours: 72,
  staleAfterDays: 180,
  autoAccept: { enabled: false, kinds: ["fact", "episode"], afterDays: 7 },
  embedding: { model: null, dim: null },
  consolidateEvery: { sessions: 10, days: 7 },
  incognito: false,
};

describe("defaults", () => {
  it("are the ones section 17 declares, exactly", () => {
    expect(DEFAULT_CONFIG).toEqual(SPEC_DEFAULTS);
  });

  it("come back from an empty, null or undefined input", () => {
    expect(parseConfig({})).toEqual(SPEC_DEFAULTS);
    expect(parseConfig(null)).toEqual(SPEC_DEFAULTS);
    expect(parseConfig(undefined)).toEqual(SPEC_DEFAULTS);
  });

  it("give procedure no half life", () => {
    expect(Object.keys(DEFAULT_CONFIG.halfLifeDays)).not.toContain("procedure");
  });

  it("are not shared between parses", () => {
    const first = parseConfig({});
    first.autoAccept.kinds.push("reference");
    expect(parseConfig({}).autoAccept.kinds).toEqual(["fact", "episode"]);
  });
});

describe("parseConfig", () => {
  it("fills the missing keys of a partial nested object", () => {
    const config = parseConfig({ halfLifeDays: { episode: 30 }, recall: { floor: 0.5 } });
    expect(config.halfLifeDays).toEqual({ fact: 365, preference: 730, episode: 30, reference: 365 });
    expect(config.recall).toEqual({ floor: 0.5, maxItems: 8, tokenBudget: 1200 });
    expect(config.coreTokenCap).toBe(800);
  });

  it("refuses an unknown key at the top and inside a group", () => {
    expect(safeParseConfig({ floor: 0.4 }).success).toBe(false);
    expect(safeParseConfig({ recall: { flor: 0.4 } }).success).toBe(false);
    expect(safeParseConfig({ halfLifeDays: { procedure: 30 } }).success).toBe(false);
  });

  it("refuses out of range values", () => {
    expect(safeParseConfig({ recall: { floor: 1.5 } }).success).toBe(false);
    expect(safeParseConfig({ recall: { maxItems: 0 } }).success).toBe(false);
    expect(safeParseConfig({ recall: { tokenBudget: 99 } }).success).toBe(false);
    expect(safeParseConfig({ coreTokenCap: 8001 }).success).toBe(false);
    expect(safeParseConfig({ halfLifeDays: { fact: 6 } }).success).toBe(false);
    expect(safeParseConfig({ sessionNoteTtlHours: 1.5 }).success).toBe(false);
  });

  it("refuses procedure as an auto accept kind", () => {
    expect(safeParseConfig({ autoAccept: { kinds: ["procedure"] } }).success).toBe(false);
    expect(parseConfig({ autoAccept: { kinds: ["preference"] } }).autoAccept.kinds).toEqual([
      "preference",
    ]);
  });

  it("checks the shape of the default shelf", () => {
    expect(parseConfig({ defaultShelf: "LIF/GTH" }).defaultShelf).toBe("LIF/GTH");
    expect(safeParseConfig({ defaultShelf: "dsk/ret" }).success).toBe(false);
    expect(safeParseConfig({ defaultShelf: "DSKRET" }).success).toBe(false);
  });

  it("takes an embedding model and dimension", () => {
    const config = parseConfig({ embedding: { model: "nomic-embed-text", dim: 768 } });
    expect(config.embedding).toEqual({ model: "nomic-embed-text", dim: 768 });
  });

  it("throws on a bad value", () => {
    expect(() => parseConfig({ incognito: "yes" })).toThrow(z.ZodError);
  });
});

describe("mergeConfig", () => {
  it("merges nested groups key by key and leaves the base alone", () => {
    const base = parseConfig({ halfLifeDays: { episode: 30 } });
    const merged = mergeConfig(base, { halfLifeDays: { fact: 400 }, incognito: true });

    expect(merged.halfLifeDays).toEqual({ fact: 400, preference: 730, episode: 30, reference: 365 });
    expect(merged.incognito).toBe(true);
    expect(base.halfLifeDays.fact).toBe(365);
    expect(base.incognito).toBe(false);
  });

  it("replaces arrays whole", () => {
    const merged = mergeConfig(DEFAULT_CONFIG, { autoAccept: { kinds: ["reference"] } });
    expect(merged.autoAccept).toEqual({ enabled: false, kinds: ["reference"], afterDays: 7 });
  });

  it("can set a nullable value back to null", () => {
    const withModel = mergeConfig(DEFAULT_CONFIG, { embedding: { model: "m", dim: 3 } });
    const cleared = mergeConfig(withModel, { embedding: { model: null, dim: null } });
    expect(cleared.embedding).toEqual({ model: null, dim: null });
  });

  it("ignores an undefined value in the patch", () => {
    expect(mergeConfig(DEFAULT_CONFIG, { coreTokenCap: undefined })).toEqual(DEFAULT_CONFIG);
  });

  it("validates the result", () => {
    expect(() => mergeConfig(DEFAULT_CONFIG, { recall: { floor: -1 } })).toThrow(z.ZodError);
    expect(() => mergeConfig(DEFAULT_CONFIG, { typo: 1 })).toThrow(z.ZodError);
  });
});

/**
 * config.schema.json describes this module's config to a host kernel. It is
 * written by hand and read by something else, so it gets a test that it agrees
 * with the zod schema: the same keys at every depth, the same defaults, the
 * same ranges, the same allowed values. When this fails, whichever file is
 * behind is the bug.
 */
describe("config.schema.json", () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
  const schema = JSON.parse(readFileSync(join(repoRoot, "config.schema.json"), "utf8")) as JsonNode;

  type JsonNode = {
    type?: string | string[];
    default?: unknown;
    minimum?: number;
    maximum?: number;
    pattern?: string;
    additionalProperties?: boolean;
    properties?: Record<string, JsonNode>;
    items?: JsonNode;
    enum?: unknown[];
  };

  /** Peels the wrappers that do not change what a value may be. */
  function unwrap(type: z.ZodTypeAny): { inner: z.ZodTypeAny; nullable: boolean } {
    let current = type;
    let nullable = false;
    for (;;) {
      if (current instanceof z.ZodDefault) current = current._def.innerType;
      else if (current instanceof z.ZodNullable) {
        nullable = true;
        current = current._def.innerType;
      } else if (current instanceof z.ZodOptional) current = current._def.innerType;
      else return { inner: current, nullable };
    }
  }

  function numberBounds(type: z.ZodNumber): { min?: number; max?: number; int: boolean } {
    const bounds: { min?: number; max?: number; int: boolean } = { int: false };
    for (const check of type._def.checks) {
      if (check.kind === "min") bounds.min = check.value;
      if (check.kind === "max") bounds.max = check.value;
      if (check.kind === "int") bounds.int = true;
    }
    return bounds;
  }

  function jsonTypes(node: JsonNode): string[] {
    if (node.type === undefined) return [];
    return Array.isArray(node.type) ? [...node.type].sort() : [node.type];
  }

  function compare(path: string, zodType: z.ZodTypeAny, node: JsonNode, defaultValue: unknown): void {
    const { inner, nullable } = unwrap(zodType);

    if (inner instanceof z.ZodObject) {
      expect(jsonTypes(node), path).toEqual(["object"]);
      expect(node.additionalProperties, `${path} additionalProperties`).toBe(false);
      const shape = inner.shape as Record<string, z.ZodTypeAny>;
      const properties = node.properties ?? {};
      expect(Object.keys(properties).sort(), `${path} keys`).toEqual(Object.keys(shape).sort());
      for (const key of Object.keys(shape)) {
        const child = properties[key];
        if (!child) continue;
        compare(`${path}.${key}`, shape[key]!, child, (defaultValue as Record<string, unknown>)[key]);
      }
      return;
    }

    // A leaf carries its default, and it is the one core falls back to.
    expect(node.default, `${path} default`).toEqual(defaultValue);

    if (inner instanceof z.ZodNumber) {
      const bounds = numberBounds(inner);
      const expected = bounds.int ? "integer" : "number";
      expect(jsonTypes(node), `${path} type`).toEqual(nullable ? [expected, "null"].sort() : [expected]);
      expect(node.minimum, `${path} minimum`).toBe(bounds.min);
      expect(node.maximum, `${path} maximum`).toBe(bounds.max);
    } else if (inner instanceof z.ZodString) {
      expect(jsonTypes(node), `${path} type`).toEqual(nullable ? ["null", "string"] : ["string"]);
      const regex = inner._def.checks.find((check) => check.kind === "regex");
      // RegExp.source escapes a slash, so compare two compiled sources.
      const declared = node.pattern === undefined ? undefined : new RegExp(node.pattern).source;
      expect(declared, `${path} pattern`).toBe(regex && "regex" in regex ? regex.regex.source : undefined);
    } else if (inner instanceof z.ZodBoolean) {
      expect(jsonTypes(node), `${path} type`).toEqual(["boolean"]);
    } else if (inner instanceof z.ZodArray) {
      expect(jsonTypes(node), `${path} type`).toEqual(["array"]);
      const element = unwrap(inner._def.type).inner;
      expect(element).toBeInstanceOf(z.ZodEnum);
      expect([...(node.items?.enum ?? [])].sort(), `${path} items`).toEqual(
        [...(element as z.ZodEnum<[string, ...string[]]>).options].sort(),
      );
    } else {
      throw new Error(`${path}: no comparison for ${inner.constructor.name}`);
    }
  }

  it("is a closed object at the top", () => {
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
  });

  it("declares the same keys core does", () => {
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(Object.keys(moduleConfigSchema.shape).sort());
  });

  it("agrees with the zod schema at every depth: keys, defaults, types, ranges, values", () => {
    compare("config", moduleConfigSchema, schema, DEFAULT_CONFIG);
  });
});
