import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  DRAFT_JOBS,
  DRAFT_SCHEMAS,
  grammarFileName,
  grammarFileText,
  jsonSchemaFor,
} from "../../../src/domain/drafting/schemas.js";

/**
 * adapters/grammars/ holds the four JSON schemas a constrained local model
 * decodes against. They are generated from the zod schemas in
 * src/domain/drafting/schemas.ts and must agree with them, so the shape a
 * model is forced into and the shape propose_draft parses cannot drift.
 *
 * To regenerate after changing a zod schema:
 *   REVERIE_WRITE_GRAMMARS=1 pnpm --filter @reverie/core exec vitest run tests/domain/drafting/grammars.test.ts
 */

const here = dirname(fileURLToPath(import.meta.url));
const grammars = resolve(here, "../../../../../adapters/grammars");

describe("adapters/grammars", () => {
  if (process.env.REVERIE_WRITE_GRAMMARS === "1") {
    for (const job of DRAFT_JOBS) writeFileSync(resolve(grammars, grammarFileName(job)), grammarFileText(job));
  }

  it.each(DRAFT_JOBS)("%s.schema.json agrees with the zod schema", (job) => {
    const text = readFileSync(resolve(grammars, grammarFileName(job)), "utf8");
    expect(JSON.parse(text)).toEqual(jsonSchemaFor(job));
    expect(text).toBe(grammarFileText(job));
  });

  it("has one file per job, the four section 15 names", () => {
    expect([...DRAFT_JOBS]).toEqual(["extract", "reconcile", "consolidate", "core"]);
    expect(Object.keys(DRAFT_SCHEMAS).sort()).toEqual([...DRAFT_JOBS].sort());
  });

  it("holds no em dash or en dash", () => {
    for (const job of DRAFT_JOBS) {
      const text = readFileSync(resolve(grammars, grammarFileName(job)), "utf8");
      expect(text).not.toMatch(/[\u2013\u2014]/);
    }
  });

  it("requires a quote on every extract candidate and forbids extra keys", () => {
    const schema = jsonSchemaFor("extract") as {
      properties: { candidates: { items: { required: string[]; additionalProperties: boolean } } };
    };
    expect(schema.properties.candidates.items.required).toEqual(expect.arrayContaining(["kind", "title", "body", "occurredOn", "quote"]));
    expect(schema.properties.candidates.items.additionalProperties).toBe(false);
  });
});
