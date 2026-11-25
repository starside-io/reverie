import type { MemoryKind, TrustTier } from "../../schemas/enums.js";
import { estimateTokens } from "./budget.js";

/**
 * The core block: the one block that is always in context. docs/SPEC.md
 * section 14, guardrail 5, gates "Core is clean" and "Core is stable".
 *
 * Six slots in a fixed order, inside `coreTokenCap`:
 *
 *   owner line, procedures, pinned memories, current project, library map, status
 *
 * - Only `stated` and `confirmed` memories, whatever is pinned.
 * - Current project, library map and status carry titles and counts, never bodies.
 * - Overflow drops whole items from the bottom slot upward. A procedure is in
 *   the block complete or not at all.
 * - Byte stable: items ordered by call number, no relative time, no build
 *   timestamp. The same input gives the same bytes, so the block does not
 *   invalidate a prompt cache every time a session starts.
 *
 * Pure: the input is plain data the caller has already read.
 */

export const CORE_SLOTS = ["owner", "procedures", "pinned", "project", "library", "status"] as const;
export type CoreSlot = (typeof CORE_SLOTS)[number];

/** The tiers allowed into the block. */
export const CORE_TRUST: readonly TrustTier[] = ["stated", "confirmed"];

/** How many recently confirmed project entries the project slot names. */
export const CORE_PROJECT_ENTRIES = 3;

/** How many of the most used tags the library map names. Starting value. */
export const CORE_TOP_TAGS = 10;

export interface CoreMemory {
  call: string;
  kind: MemoryKind;
  title: string;
  body: string;
  why?: string | null;
  howToApply?: string | null;
  trust: TrustTier;
  pinned?: boolean;
}

export interface CoreProjectEntry {
  call: string;
  title: string;
  trust: TrustTier;
  /** Used only to pick the most recent; never rendered. */
  lastConfirmedAt: Date;
}

export interface CoreProject {
  name: string;
  /** Shelf path, `WRK/NST`. */
  shelf: string;
  /** Any number of the project's entries; the three most recently confirmed are named. */
  entries: readonly CoreProjectEntry[];
}

export interface CoreShelf {
  code: string;
  name: string;
  count: number;
}

export interface CoreSection {
  code: string;
  name: string;
  shelves: readonly CoreShelf[];
}

export interface CoreTag {
  slug: string;
  count: number;
}

export interface CoreBlockInput {
  /** Who the owner is, in one line. Null or blank leaves the slot out. */
  ownerLine: string | null;
  /** Procedure candidates. Anything that is not a procedure is ignored here. */
  procedures: readonly CoreMemory[];
  /** Pinned memories of any kind. */
  pinned: readonly CoreMemory[];
  project: CoreProject | null;
  library: { sections: readonly CoreSection[]; tags: readonly CoreTag[] };
  status: { proposalsWaiting: number; consolidationDue: boolean };
  /** coreTokenCap from config. */
  tokenCap: number;
}

export interface CoreItemRef {
  slot: CoreSlot;
  /** A call number for a memory or a project entry, otherwise a fixed label. */
  ref: string;
}

export type CoreExclusionReason = "trust" | "duplicate";

export interface CoreBlock {
  text: string;
  /** estimateTokens(text); never above the cap. */
  tokens: number;
  included: CoreItemRef[];
  /** Cut for the cap, in the order they were cut: bottom slot first. */
  dropped: CoreItemRef[];
  /** Never eligible: an inferred or external memory, or a memory already in an earlier slot. */
  excluded: Array<CoreItemRef & { reason: CoreExclusionReason }>;
}

interface Item {
  ref: string;
  text: string;
}

const SLOT_HEADINGS: Record<CoreSlot, string> = {
  owner: "## Owner",
  procedures: "## Procedures",
  pinned: "## Pinned",
  project: "## Current project",
  library: "## Library",
  status: "## Status",
};

function byCall<T extends { call: string }>(a: T, b: T): number {
  return a.call < b.call ? -1 : a.call > b.call ? 1 : 0;
}

/** Line endings to \n, trailing space off each line, the whole trimmed. */
function clean(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n")
    .trim();
}

/** Collapses to one line, for titles and names. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function renderProcedure(memory: CoreMemory): string {
  const lines = [`[${memory.call}] ${oneLine(memory.title)}`, clean(memory.body)];
  if (memory.why && memory.why.trim()) lines.push(`Why: ${clean(memory.why)}`);
  if (memory.howToApply && memory.howToApply.trim()) lines.push(`How to apply: ${clean(memory.howToApply)}`);
  return lines.join("\n");
}

function renderPinned(memory: CoreMemory): string {
  return [`[${memory.call}] (${memory.kind}) ${oneLine(memory.title)}`, clean(memory.body)].join("\n");
}

function render(slots: ReadonlyMap<CoreSlot, Item[]>): string {
  const parts: string[] = [];
  for (const slot of CORE_SLOTS) {
    const items = slots.get(slot) ?? [];
    if (items.length === 0) continue;
    // Multi line items get a blank line between them; single line items sit together.
    const separator = items.some((item) => item.text.includes("\n")) ? "\n\n" : "\n";
    parts.push(`${SLOT_HEADINGS[slot]}\n${items.map((item) => item.text).join(separator)}`);
  }
  return parts.join("\n\n");
}

/** Builds the block, cutting whole items from the bottom slot upward until it fits. */
export function buildCoreBlock(input: CoreBlockInput): CoreBlock {
  const excluded: CoreBlock["excluded"] = [];
  const trusted = (slot: CoreSlot, memory: { call: string; trust: TrustTier }) => {
    if (CORE_TRUST.includes(memory.trust)) return true;
    excluded.push({ slot, ref: memory.call, reason: "trust" });
    return false;
  };

  const slots = new Map<CoreSlot, Item[]>();

  // Owner line.
  const owner = input.ownerLine === null ? "" : oneLine(input.ownerLine);
  slots.set("owner", owner ? [{ ref: "owner", text: owner }] : []);

  // Procedures: pinned first, each group by call number.
  const seen = new Set<string>();
  const procedures = input.procedures
    .filter((memory) => memory.kind === "procedure")
    .filter((memory) => trusted("procedures", memory))
    .filter((memory) => {
      if (seen.has(memory.call)) {
        excluded.push({ slot: "procedures", ref: memory.call, reason: "duplicate" });
        return false;
      }
      seen.add(memory.call);
      return true;
    })
    .sort((a, b) => Number(b.pinned === true) - Number(a.pinned === true) || byCall(a, b));
  slots.set(
    "procedures",
    procedures.map((memory) => ({ ref: memory.call, text: renderProcedure(memory) })),
  );

  // Pinned memories: by call number, none repeated from the procedures slot.
  const pinned = input.pinned
    .filter((memory) => trusted("pinned", memory))
    .filter((memory) => {
      if (seen.has(memory.call)) {
        excluded.push({ slot: "pinned", ref: memory.call, reason: "duplicate" });
        return false;
      }
      seen.add(memory.call);
      return true;
    })
    .sort(byCall);
  slots.set("pinned", pinned.map((memory) => ({ ref: memory.call, text: renderPinned(memory) })));

  // Current project: name and shelf, then titles of the three most recently
  // confirmed entries, rendered by call number.
  const projectItems: Item[] = [];
  if (input.project) {
    projectItems.push({
      ref: "project",
      text: `${oneLine(input.project.name)}, shelf ${oneLine(input.project.shelf)}`,
    });
    const recent = input.project.entries
      .filter((entry) => trusted("project", entry))
      .sort((a, b) => b.lastConfirmedAt.getTime() - a.lastConfirmedAt.getTime() || byCall(a, b))
      .slice(0, CORE_PROJECT_ENTRIES)
      .sort(byCall);
    for (const entry of recent) {
      projectItems.push({ ref: entry.call, text: `- [${entry.call}] ${oneLine(entry.title)}` });
    }
  }
  slots.set("project", projectItems);

  // Library map: sections and shelves by code, with counts; then the most used tags.
  const libraryItems: Item[] = [...input.library.sections]
    .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
    .map((section) => {
      const shelves = [...section.shelves]
        .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
        .map((shelf) => `${shelf.code} ${oneLine(shelf.name)} (${shelf.count})`)
        .join(", ");
      return {
        ref: `section:${section.code}`,
        text: `${section.code} ${oneLine(section.name)}${shelves ? `: ${shelves}` : ""}`,
      };
    });
  const tags = [...input.library.tags]
    .sort((a, b) => b.count - a.count || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, CORE_TOP_TAGS);
  if (tags.length > 0) {
    libraryItems.push({ ref: "tags", text: `Tags: ${tags.map((tag) => `#${tag.slug} (${tag.count})`).join(", ")}` });
  }
  slots.set("library", libraryItems);

  // Status: last, because it is the part most likely to change.
  slots.set("status", [
    { ref: "status:proposals", text: `Proposals in review: ${input.status.proposalsWaiting}` },
    { ref: "status:consolidation", text: `Consolidation due: ${input.status.consolidationDue ? "yes" : "no"}` },
  ]);

  // Cut whole items, the last item of the lowest non-empty slot first.
  const dropped: CoreItemRef[] = [];
  let text = render(slots);
  while (estimateTokens(text) > input.tokenCap) {
    const slot = [...CORE_SLOTS].reverse().find((name) => (slots.get(name) ?? []).length > 0);
    if (!slot) break;
    const removed = slots.get(slot)!.pop()!;
    dropped.push({ slot, ref: removed.ref });
    text = render(slots);
  }

  const included: CoreItemRef[] = [];
  for (const slot of CORE_SLOTS) {
    for (const item of slots.get(slot) ?? []) included.push({ slot, ref: item.ref });
  }

  return { text, tokens: estimateTokens(text), included, dropped, excluded };
}
