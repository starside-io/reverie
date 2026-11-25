import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ENUM_COLUMNS } from "../../src/schemas/enums.js";
import {
  QUOTE_MAX_LENGTH,
  checkConstraints,
  enumCheckConstraints,
} from "../../src/storage/enum-checks.js";
import { throwawaySilo } from "./throwaway.js";

/**
 * The schema the migrations build, checked with raw SQL so nothing above the
 * database can paper over a missing constraint. All data is invented.
 */

let silo: ReturnType<typeof throwawaySilo>;
let counter = 0;

const NOW = "2026-12-27 10:00:00";
const DAY = "2026-12-24 00:00:00";

beforeAll(() => {
  silo = throwawaySilo();
  insert("Section", { id: "sec-lif", code: "LIF", name: "Life", order: 1 });
  insert("Shelf", {
    id: "sh-gth",
    sectionId: "sec-lif",
    code: "GTH",
    name: "Gatherings",
    description: "Parties, dinners, visits.",
    order: 1,
  });
});

afterAll(() => {
  silo.db.close();
});

type Row = Record<string, string | number | null>;

function insert(table: string, row: Row): void {
  const columns = Object.keys(row);
  const sql = `INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(", ")})
               VALUES (${columns.map(() => "?").join(", ")})`;
  silo.db.prepare(sql).run(...Object.values(row));
}

function count(sql: string, ...params: Array<string | number>): number {
  const row = silo.db.prepare(sql).get(...params) as { n: number | bigint };
  return Number(row.n);
}

function tableSql(name: string): string {
  const row = silo.db
    .prepare(`SELECT "sql" FROM sqlite_master WHERE "type" = 'table' AND "name" = ?`)
    .get(name) as { sql: string } | undefined;
  return row?.sql ?? "";
}

/** A valid Memory row on LIF/GTH, unique on every call unless overridden. */
function memoryRow(overrides: Row = {}): Row {
  counter += 1;
  const seq = counter;
  return {
    id: `m-${counter}`,
    callNumber: `LIF/GTH/2026-12-24/${String(seq).padStart(3, "0")}`,
    shelfId: "sh-gth",
    occurredOn: DAY,
    seq,
    kind: "episode",
    scope: "global",
    title: "Christmas at home",
    body: "Hosted Christmas with Jane Doe, John Doe and Sam Rivera.",
    trust: "stated",
    state: "active",
    validFrom: DAY,
    lastConfirmedAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function addMemory(overrides: Row = {}): string {
  const row = memoryRow(overrides);
  insert("Memory", row);
  return String(row["id"]);
}

/** A valid row for every table that carries an enum column. */
function validRow(table: string): Row {
  counter += 1;
  switch (table) {
    case "Memory":
      return memoryRow();
    case "MemoryRef":
      return { id: `r-${counter}`, memoryId: addMemory(), role: "attendee", label: "Jane Doe" };
    case "MemoryVersion":
      return { id: `v-${counter}`, memoryId: "m-any", operation: "create", actor: "user" };
    case "Source":
      return { id: `s-${counter}`, kind: "conversation", label: "session of 2026-12-27", trust: "stated" };
    case "MemoryLink":
      return { id: `l-${counter}`, fromId: addMemory(), toId: addMemory(), relation: "elaborates" };
    case "RecallLog":
      return { id: `rl-${counter}`, scope: "global", memoryIds: "[]", scores: "[]", budget: 1200 };
    default:
      throw new Error(`No valid row for ${table}`);
  }
}

describe("the migrated schema", () => {
  it("creates every table module.json lists, and the search table", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const manifest = JSON.parse(
      readFileSync(join(here, "..", "..", "..", "..", "module.json"), "utf8"),
    ) as { silo: { tables: string[]; search: string[] } };

    const names = (
      silo.db
        .prepare(`SELECT "name" FROM sqlite_master WHERE "type" = 'table'`)
        .all() as Array<{ name: string }>
    ).map((row) => row.name);

    expect(manifest.silo.tables).toHaveLength(15);
    for (const table of [...manifest.silo.tables, ...manifest.silo.search]) {
      expect(names, table).toContain(table);
    }
  });

  it("keeps local folder paths out of Project", () => {
    expect(tableSql("Project")).not.toMatch(/path|folder/i);
  });
});

describe("enum CHECK constraints", () => {
  it("carries one per enum column, with the values zod allows", () => {
    for (const constraint of checkConstraints()) {
      expect(tableSql(constraint.table), constraint.name).toContain(constraint.name);
      expect(tableSql(constraint.table), constraint.name).toContain(constraint.sql);
    }
  });

  for (const entry of ENUM_COLUMNS) {
    it(`${entry.table}.${entry.column} refuses a value outside the zod enum`, () => {
      const row = { ...validRow(entry.table), [entry.column]: "not_a_real_value" };
      expect(() => insert(entry.table, row)).toThrow(/CHECK constraint failed/);
    });

    it(`${entry.table}.${entry.column} accepts every value the zod enum allows`, () => {
      for (const value of entry.values) {
        insert(entry.table, { ...validRow(entry.table), [entry.column]: value });
      }
    });
  }

  it("covers every enum column, one constraint each", () => {
    expect(enumCheckConstraints()).toHaveLength(ENUM_COLUMNS.length);
  });
});

describe("the quote length CHECK", () => {
  function quoteRow(quote: string): Row {
    counter += 1;
    const sourceId = `s-q-${counter}`;
    insert("Source", { id: sourceId, kind: "conversation", label: "session of 2026-12-27", trust: "stated" });
    return { memoryId: addMemory(), sourceId, quote };
  }

  it(`accepts a quote of exactly ${QUOTE_MAX_LENGTH} characters, counted as characters`, () => {
    insert("MemorySource", quoteRow("a".repeat(QUOTE_MAX_LENGTH)));
    // Two bytes each in UTF-8, one character each to length().
    insert("MemorySource", quoteRow("é".repeat(QUOTE_MAX_LENGTH)));
  });

  it("refuses one character more", () => {
    expect(() => insert("MemorySource", quoteRow("a".repeat(QUOTE_MAX_LENGTH + 1)))).toThrow(
      /CHECK constraint failed/,
    );
  });
});

describe("memory_fts", () => {
  function hits(query: string): number {
    return count(`SELECT COUNT(*) AS n FROM "memory_fts" WHERE "memory_fts" MATCH ?`, query);
  }

  function integrity(): void {
    // Throws if the index and the Memory rows disagree.
    silo.db.exec(`INSERT INTO "memory_fts"("memory_fts") VALUES ('integrity-check')`);
  }

  it("makes an inserted memory searchable by title, body and why", () => {
    addMemory({
      title: "Oven trouble",
      body: "The oven died mid afternoon, so we ordered pizza.",
      why: "Remember to check the oven before hosting.",
    });
    expect(hits("pizza")).toBe(1);
    expect(hits("trouble")).toBe(1);
    expect(hits("hosting")).toBe(1);
    integrity();
  });

  it("folds diacritics", () => {
    addMemory({ body: "Met Sam Rivera at the café on the corner." });
    expect(hits("cafe")).toBe(1);
  });

  it("reindexes a memory when it is updated", () => {
    const id = addMemory({ body: "Jane Doe brought a pavlova." });
    expect(hits("pavlova")).toBe(1);

    silo.db.prepare(`UPDATE "Memory" SET "body" = ? WHERE "id" = ?`).run("Jane Doe brought a trifle.", id);
    expect(hits("pavlova")).toBe(0);
    expect(hits("trifle")).toBe(1);
    integrity();
  });

  it("makes a tag slug in tagText searchable as a word", () => {
    addMemory({ body: "Pricing decided on holiday.", tagText: "nightstash vacation" });
    expect(hits("nightstash")).toBe(1);
    expect(hits("tagText:vacation")).toBe(1);
  });

  it("leaves no entry after a delete, and the delete cascades the rest", () => {
    const id = addMemory({ body: "A one-off zeppelin ride.", tagText: "zeppelin" });
    insert("Tag", { id: "t-zep", slug: "zeppelin", colour: "#888888" });
    insert("MemoryTag", { memoryId: id, tagId: "t-zep" });
    expect(hits("zeppelin")).toBe(1);

    silo.db.prepare(`DELETE FROM "Memory" WHERE "id" = ?`).run(id);
    expect(hits("zeppelin")).toBe(0);
    expect(count(`SELECT COUNT(*) AS n FROM "MemoryTag" WHERE "memoryId" = ?`, id)).toBe(0);
    integrity();
  });
});

describe("call number uniqueness", () => {
  it("refuses a second memory at the same shelf, day and sequence", () => {
    addMemory({ callNumber: "LIF/GTH/2026-12-31/001", occurredOn: "2026-12-31 00:00:00", seq: 1 });
    expect(() =>
      addMemory({ callNumber: "LIF/GTH/2026-12-31/001b", occurredOn: "2026-12-31 00:00:00", seq: 1 }),
    ).toThrow(/UNIQUE constraint failed/);
  });

  it("allows the same sequence on another day", () => {
    addMemory({ callNumber: "LIF/GTH/2027-01-01/001", occurredOn: "2027-01-01 00:00:00", seq: 1 });
  });

  it("refuses a call number already in use", () => {
    addMemory({ callNumber: "LIF/GTH/2027-01-02/001", occurredOn: "2027-01-02 00:00:00", seq: 1 });
    expect(() =>
      addMemory({ callNumber: "LIF/GTH/2027-01-02/001", occurredOn: "2027-01-02 00:00:00", seq: 2 }),
    ).toThrow(/UNIQUE constraint failed/);
  });
});

describe("foreign keys", () => {
  it("refuses to delete a shelf that holds memories", () => {
    addMemory();
    expect(() => silo.db.prepare(`DELETE FROM "Shelf" WHERE "id" = 'sh-gth'`).run()).toThrow(
      /FOREIGN KEY constraint failed/,
    );
  });

  it("refuses to delete a section that holds shelves", () => {
    expect(() => silo.db.prepare(`DELETE FROM "Section" WHERE "id" = 'sec-lif'`).run()).toThrow(
      /FOREIGN KEY constraint failed/,
    );
  });

  it("lets an empty shelf go", () => {
    insert("Shelf", {
      id: "sh-empty",
      sectionId: "sec-lif",
      code: "TRV",
      name: "Travel",
      description: "Trips.",
      order: 2,
    });
    silo.db.prepare(`DELETE FROM "Shelf" WHERE "id" = 'sh-empty'`).run();
    expect(count(`SELECT COUNT(*) AS n FROM "Shelf" WHERE "id" = 'sh-empty'`)).toBe(0);
  });

  it("cascades a memory delete into its tags, refs, sources, links and vector", () => {
    const id = addMemory();
    const other = addMemory();
    insert("Tag", { id: "t-xmas", slug: "christmas", colour: "#cc3333" });
    insert("MemoryTag", { memoryId: id, tagId: "t-xmas" });
    insert("MemoryRef", { id: "r-jane", memoryId: id, role: "attendee", label: "Jane Doe" });
    insert("Source", { id: "s-xmas", kind: "conversation", label: "session of 2026-12-27", trust: "stated" });
    insert("MemorySource", { memoryId: id, sourceId: "s-xmas", quote: "I organised Christmas at mine." });
    insert("MemoryLink", { id: "l-xmas", fromId: other, toId: id, relation: "elaborates" });
    insert("Embedding", { memoryId: id, model: "test-model", dim: 1, vector: "0000" });
    insert("CallNumberAlias", { oldCallNumber: "DSK/RET/2026-12-24/001", memoryId: id });
    insert("MemoryVersion", { id: "v-xmas", memoryId: id, operation: "create", actor: "user" });

    silo.db.prepare(`DELETE FROM "Memory" WHERE "id" = ?`).run(id);

    expect(count(`SELECT COUNT(*) AS n FROM "MemoryTag" WHERE "memoryId" = ?`, id)).toBe(0);
    expect(count(`SELECT COUNT(*) AS n FROM "MemoryRef" WHERE "memoryId" = ?`, id)).toBe(0);
    expect(count(`SELECT COUNT(*) AS n FROM "MemorySource" WHERE "memoryId" = ?`, id)).toBe(0);
    expect(count(`SELECT COUNT(*) AS n FROM "MemoryLink" WHERE "toId" = ?`, id)).toBe(0);
    expect(count(`SELECT COUNT(*) AS n FROM "Embedding" WHERE "memoryId" = ?`, id)).toBe(0);

    // What outlives the row: the tag, the source, the retired number and the
    // version, which core redacts.
    expect(count(`SELECT COUNT(*) AS n FROM "Tag" WHERE "id" = 't-xmas'`)).toBe(1);
    expect(count(`SELECT COUNT(*) AS n FROM "Source" WHERE "id" = 's-xmas'`)).toBe(1);
    expect(
      count(
        `SELECT COUNT(*) AS n FROM "CallNumberAlias" WHERE "oldCallNumber" = 'DSK/RET/2026-12-24/001' AND "memoryId" IS NULL`,
      ),
    ).toBe(1);
    expect(count(`SELECT COUNT(*) AS n FROM "MemoryVersion" WHERE "memoryId" = ?`, id)).toBe(1);
  });

  it("refuses to delete a source a memory still cites", () => {
    const id = addMemory();
    insert("Source", { id: "s-held", kind: "file", label: "notes.md", trust: "stated" });
    insert("MemorySource", { memoryId: id, sourceId: "s-held", quote: "John Doe moved to Lisbon." });
    expect(() => silo.db.prepare(`DELETE FROM "Source" WHERE "id" = 's-held'`).run()).toThrow(
      /FOREIGN KEY constraint failed/,
    );
  });
});
