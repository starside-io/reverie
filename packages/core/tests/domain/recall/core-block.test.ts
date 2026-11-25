import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../../../src/config/index.js";
import { checkRelativeDates } from "../../../src/domain/discipline.js";
import { estimateTokens } from "../../../src/domain/recall/budget.js";
import {
  CORE_SLOTS,
  buildCoreBlock,
  type CoreBlockInput,
  type CoreMemory,
} from "../../../src/domain/recall/core-block.js";

// docs/SPEC.md section 14 (the core block), guardrail 5, and the gates
// "Core is clean" and "Core is stable" in section 16.

function procedure(call: string, overrides: Partial<CoreMemory> = {}): CoreMemory {
  return {
    call,
    kind: "procedure",
    title: `Rule ${call}`,
    body: `Body of ${call}. Cite the file and line for every claim.`,
    why: "Jane Doe checks answers against the source.",
    howToApply: "Every answer that names code.",
    trust: "stated",
    pinned: false,
    ...overrides,
  };
}

function pinnedFact(call: string, overrides: Partial<CoreMemory> = {}): CoreMemory {
  return {
    call,
    kind: "fact",
    title: `Pinned ${call}`,
    body: `Jane Doe lives in Lisbon (${call}).`,
    trust: "confirmed",
    pinned: true,
    ...overrides,
  };
}

function library(): CoreBlockInput["library"] {
  return {
    sections: [
      {
        code: "WRK",
        name: "Work",
        shelves: [
          { code: "NST", name: "Night Stash", count: 14 },
          { code: "GEN", name: "General", count: 3 },
        ],
      },
      {
        code: "LIF",
        name: "Life",
        shelves: [
          { code: "GTH", name: "Gatherings", count: 12 },
          { code: "HOW", name: "How I work", count: 5 },
        ],
      },
    ],
    tags: [
      { slug: "hosting", count: 3 },
      { slug: "christmas", count: 5 },
      { slug: "nightstash", count: 14 },
      { slug: "birthdays", count: 3 },
    ],
  };
}

function base(overrides: Partial<CoreBlockInput> = {}): CoreBlockInput {
  return {
    ownerLine: "Jane Doe, engineer in Lisbon, writes TypeScript, prefers short answers.",
    procedures: [procedure("LIF/HOW/2026-03-02/001"), procedure("LIF/HOW/2026-01-15/001", { pinned: true })],
    pinned: [pinnedFact("LIF/FAM/2026-05-01/002"), pinnedFact("LIF/FAM/2026-02-01/001")],
    project: {
      name: "Night Stash",
      shelf: "WRK/NST",
      entries: [
        { call: "WRK/NST/2026-11-01/001", title: "Chose SQLite", trust: "stated", lastConfirmedAt: new Date("2026-11-20T00:00:00Z") },
        { call: "WRK/NST/2026-10-01/001", title: "Repo renamed", trust: "confirmed", lastConfirmedAt: new Date("2026-11-22T00:00:00Z") },
        { call: "WRK/NST/2026-09-01/001", title: "Old decision", trust: "stated", lastConfirmedAt: new Date("2026-01-01T00:00:00Z") },
        { call: "WRK/NST/2026-11-10/001", title: "Release plan", trust: "stated", lastConfirmedAt: new Date("2026-11-21T00:00:00Z") },
        { call: "WRK/NST/2026-11-24/001", title: "Guessed deadline", trust: "inferred", lastConfirmedAt: new Date("2026-11-24T00:00:00Z") },
      ],
    },
    library: library(),
    status: { proposalsWaiting: 3, consolidationDue: false },
    tokenCap: DEFAULT_CONFIG.coreTokenCap,
    ...overrides,
  };
}

function headings(text: string): string[] {
  return text.split("\n").filter((line) => line.startsWith("## "));
}

describe("layout", () => {
  it("renders the six slots in the fixed order", () => {
    const block = buildCoreBlock(base());
    expect(headings(block.text)).toEqual([
      "## Owner",
      "## Procedures",
      "## Pinned",
      "## Current project",
      "## Library",
      "## Status",
    ]);
    expect(CORE_SLOTS).toEqual(["owner", "procedures", "pinned", "project", "library", "status"]);
    expect(block.dropped).toEqual([]);
  });

  it("renders a known input to known bytes", () => {
    const block = buildCoreBlock(
      base({
        procedures: [procedure("LIF/HOW/2026-01-15/001", { title: "Cite sources", body: "Cite the file and line.", why: null, howToApply: null })],
        pinned: [pinnedFact("LIF/FAM/2026-02-01/001", { title: "Home", body: "Jane Doe lives in Lisbon." })],
        project: {
          name: "Night Stash",
          shelf: "WRK/NST",
          entries: [{ call: "WRK/NST/2026-11-01/001", title: "Chose SQLite", trust: "stated", lastConfirmedAt: new Date(0) }],
        },
        library: { sections: [{ code: "LIF", name: "Life", shelves: [{ code: "GTH", name: "Gatherings", count: 12 }] }], tags: [{ slug: "christmas", count: 5 }] },
      }),
    );
    expect(block.text).toBe(
      [
        "## Owner",
        "Jane Doe, engineer in Lisbon, writes TypeScript, prefers short answers.",
        "",
        "## Procedures",
        "[LIF/HOW/2026-01-15/001] Cite sources",
        "Cite the file and line.",
        "",
        "## Pinned",
        "[LIF/FAM/2026-02-01/001] (fact) Home",
        "Jane Doe lives in Lisbon.",
        "",
        "## Current project",
        "Night Stash, shelf WRK/NST",
        "- [WRK/NST/2026-11-01/001] Chose SQLite",
        "",
        "## Library",
        "LIF Life: GTH Gatherings (12)",
        "Tags: #christmas (5)",
        "",
        "## Status",
        "Proposals in review: 3",
        "Consolidation due: no",
      ].join("\n"),
    );
    expect(block.tokens).toBe(estimateTokens(block.text));
  });

  it("puts pinned procedures first, then orders each group by call number", () => {
    const block = buildCoreBlock(
      base({
        procedures: [
          procedure("LIF/HOW/2026-05-01/001"),
          procedure("LIF/HOW/2026-04-01/001", { pinned: true }),
          procedure("LIF/HOW/2026-01-01/001"),
          procedure("LIF/HOW/2026-06-01/001", { pinned: true }),
        ],
      }),
    );
    const order = block.included.filter((ref) => ref.slot === "procedures").map((ref) => ref.ref);
    expect(order).toEqual([
      "LIF/HOW/2026-04-01/001",
      "LIF/HOW/2026-06-01/001",
      "LIF/HOW/2026-01-01/001",
      "LIF/HOW/2026-05-01/001",
    ]);
  });

  it("orders pinned memories by call number", () => {
    const block = buildCoreBlock(base());
    expect(block.included.filter((ref) => ref.slot === "pinned").map((ref) => ref.ref)).toEqual([
      "LIF/FAM/2026-02-01/001",
      "LIF/FAM/2026-05-01/002",
    ]);
  });

  it("names the three most recently confirmed project entries, by call number, titles only", () => {
    const block = buildCoreBlock(base());
    expect(block.included.filter((ref) => ref.slot === "project").map((ref) => ref.ref)).toEqual([
      "project",
      "WRK/NST/2026-10-01/001",
      "WRK/NST/2026-11-01/001",
      "WRK/NST/2026-11-10/001",
    ]);
    expect(block.text).not.toContain("Old decision");
  });

  it("sorts sections and shelves by code and tags by count, then slug", () => {
    const block = buildCoreBlock(base());
    expect(block.text).toContain(
      "LIF Life: GTH Gatherings (12), HOW How I work (5)\nWRK Work: GEN General (3), NST Night Stash (14)",
    );
    expect(block.text).toContain("Tags: #nightstash (14), #christmas (5), #birthdays (3), #hosting (3)");
  });

  it("names at most ten tags", () => {
    const tags = Array.from({ length: 15 }, (_, i) => ({ slug: `tag${String(i).padStart(2, "0")}`, count: 100 - i }));
    const block = buildCoreBlock(base({ library: { sections: [], tags } }));
    const line = block.text.split("\n").find((l) => l.startsWith("Tags: "))!;
    expect(line.split(", ")).toHaveLength(10);
    expect(line).not.toContain("tag10");
  });

  it("leaves an empty slot out, but always carries the status", () => {
    const block = buildCoreBlock(
      base({ ownerLine: "  ", procedures: [], pinned: [], project: null, library: { sections: [], tags: [] } }),
    );
    expect(headings(block.text)).toEqual(["## Status"]);
  });
});

describe("core is clean", () => {
  it("lets in only stated and confirmed memories, whatever is pinned", () => {
    const block = buildCoreBlock(
      base({
        procedures: [
          procedure("LIF/HOW/2026-01-01/001"),
          procedure("LIF/HOW/2026-01-02/001", { trust: "inferred", pinned: true }),
          procedure("LIF/HOW/2026-01-03/001", { trust: "external", pinned: true }),
        ],
        pinned: [
          pinnedFact("LIF/FAM/2026-01-01/001", { trust: "stated" }),
          pinnedFact("LIF/FAM/2026-01-02/001", { trust: "inferred" }),
          pinnedFact("LIF/FAM/2026-01-03/001", { trust: "external" }),
        ],
      }),
    );
    for (const call of ["LIF/HOW/2026-01-02/001", "LIF/HOW/2026-01-03/001", "LIF/FAM/2026-01-02/001", "LIF/FAM/2026-01-03/001"]) {
      expect(block.text).not.toContain(call);
      expect(block.excluded).toContainEqual(expect.objectContaining({ ref: call, reason: "trust" }));
    }
    expect(block.text).toContain("LIF/HOW/2026-01-01/001");
    expect(block.text).toContain("LIF/FAM/2026-01-01/001");
    // The inferred project entry is not named either.
    expect(block.text).not.toContain("Guessed deadline");
  });

  it("keeps anything that is not a procedure out of the procedures slot", () => {
    const block = buildCoreBlock(base({ procedures: [pinnedFact("LIF/FAM/2026-01-01/001")], pinned: [] }));
    expect(headings(block.text)).not.toContain("## Procedures");
  });

  it("does not repeat a pinned procedure in the pinned slot", () => {
    const shared = procedure("LIF/HOW/2026-01-15/001", { pinned: true });
    const block = buildCoreBlock(base({ procedures: [shared], pinned: [shared] }));
    expect(block.included.filter((ref) => ref.ref === "LIF/HOW/2026-01-15/001")).toEqual([
      { slot: "procedures", ref: "LIF/HOW/2026-01-15/001" },
    ]);
    expect(block.text.split("[LIF/HOW/2026-01-15/001]")).toHaveLength(2);
    expect(block.excluded).toContainEqual({ slot: "pinned", ref: "LIF/HOW/2026-01-15/001", reason: "duplicate" });
  });

  it("never exceeds the cap", () => {
    const procedures = Array.from({ length: 30 }, (_, i) =>
      procedure(`LIF/HOW/2026-01-${String(i + 1).padStart(2, "0")}/001`, { body: "Long rule. ".repeat(20) }),
    );
    for (const tokenCap of [100, 200, 400, 800, 1600]) {
      const block = buildCoreBlock(base({ procedures, tokenCap }));
      expect(block.tokens, String(tokenCap)).toBeLessThanOrEqual(tokenCap);
      expect(estimateTokens(block.text)).toBe(block.tokens);
    }
  });

  it("drops whole items from the bottom slot upward", () => {
    const full = buildCoreBlock(base({ tokenCap: 8000 }));
    expect(full.dropped).toEqual([]);

    // Shave a little: the status slot goes first, its last line first.
    const tight = buildCoreBlock(base({ tokenCap: full.tokens - 2 }));
    expect(tight.dropped[0]).toEqual({ slot: "status", ref: "status:consolidation" });
    expect(tight.text).toContain("## Procedures");

    // Tighter: every lower slot empties before a single procedure goes.
    const tighter = buildCoreBlock(base({ tokenCap: 60 }));
    const slotsDropped = tighter.dropped.map((ref) => ref.slot);
    const firstProcedureDrop = slotsDropped.indexOf("procedures");
    expect(firstProcedureDrop).toBeGreaterThanOrEqual(0);
    for (const slot of ["status", "library", "project", "pinned"] as const) {
      expect(slotsDropped).toContain(slot);
      expect(slotsDropped.lastIndexOf(slot)).toBeLessThan(firstProcedureDrop);
    }
    expect(tighter.included.filter((ref) => ["pinned", "project", "library", "status"].includes(ref.slot))).toEqual([]);
    // The later, unpinned procedure goes before the pinned one.
    expect(tighter.dropped[firstProcedureDrop]).toEqual({ slot: "procedures", ref: "LIF/HOW/2026-03-02/001" });
    expect(tighter.tokens).toBeLessThanOrEqual(60);
  });

  it("keeps a procedure whole or leaves it out", () => {
    const procedures = Array.from({ length: 12 }, (_, i) =>
      procedure(`LIF/HOW/2026-02-${String(i + 1).padStart(2, "0")}/001`, {
        body: `Rule number ${i + 1}. ${"Explain the reasoning in full. ".repeat(6)}End of rule ${i + 1}.`,
      }),
    );
    for (const tokenCap of [150, 300, 450, 600, 800]) {
      const block = buildCoreBlock(base({ procedures, tokenCap }));
      for (const memory of procedures) {
        const header = `[${memory.call}] ${memory.title}`;
        if (block.text.includes(header)) {
          expect(block.text, `${memory.call} at ${tokenCap}`).toContain(`${header}\n${memory.body}\nWhy: ${memory.why}\nHow to apply: ${memory.howToApply}`);
        } else {
          expect(block.text).not.toContain(`End of rule ${procedures.indexOf(memory) + 1}.`);
        }
      }
    }
  });

  it("drops the owner line last", () => {
    const block = buildCoreBlock(base({ tokenCap: 30 }));
    expect(block.included).toEqual([{ slot: "owner", ref: "owner" }]);
    expect(block.text.startsWith("## Owner\n")).toBe(true);
    expect(block.tokens).toBeLessThanOrEqual(30);

    const nothing = buildCoreBlock(base({ tokenCap: 5 }));
    expect(nothing.dropped.at(-1)).toEqual({ slot: "owner", ref: "owner" });
    expect(nothing.text).toBe("");
  });
});

describe("core is stable", () => {
  it("gives the same bytes for the same input", () => {
    expect(buildCoreBlock(base()).text).toBe(buildCoreBlock(base()).text);
  });

  it("gives the same bytes whatever order the input arrives in", () => {
    const input = base();
    const shuffled: CoreBlockInput = {
      ...input,
      procedures: [...input.procedures].reverse(),
      pinned: [...input.pinned].reverse(),
      project: { ...input.project!, entries: [...input.project!.entries].reverse() },
      library: {
        sections: [...input.library.sections].reverse().map((section) => ({ ...section, shelves: [...section.shelves].reverse() })),
        tags: [...input.library.tags].reverse(),
      },
    };
    expect(buildCoreBlock(shuffled).text).toBe(buildCoreBlock(input).text);
  });

  it("normalises line endings and trailing space", () => {
    const crlf = base({ procedures: [procedure("LIF/HOW/2026-01-15/001", { body: "Line one.  \r\nLine two.\r\n" })] });
    const lf = base({ procedures: [procedure("LIF/HOW/2026-01-15/001", { body: "Line one.\nLine two." })] });
    expect(buildCoreBlock(crlf).text).toBe(buildCoreBlock(lf).text);
  });

  it("carries no relative time and no build timestamp", () => {
    const { text } = buildCoreBlock(base());
    expect(checkRelativeDates({ kind: "fact", title: "", body: text, sourceTrust: "stated" }).findings).toEqual([]);
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    expect(text).not.toMatch(/\bago\b/);
    // lastConfirmedAt picks the project entries and is never rendered.
    expect(text).not.toContain("2026-11-20");
  });
});
