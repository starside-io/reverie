import { describe, expect, it } from "vitest";

import { diffSnapshots, formatDiff, keyedView } from "../../src/domain/transfer/diff.js";
import type { ExportSnapshot } from "../../src/domain/transfer/snapshot.js";

/**
 * The comparison itself. If this is wrong, a clean round trip report means
 * nothing, so it gets its own tests rather than being trusted because a real
 * export happened to pass.
 */

const SECTION = "11111111-1111-4111-8111-111111111111";
const SHELF = "22222222-2222-4222-8222-222222222222";
const TAG = "33333333-3333-4333-8333-333333333333";
const OTHER_TAG = "44444444-4444-4444-8444-444444444444";
const SOURCE = "55555555-5555-4555-8555-555555555555";
const MEMORY = "66666666-6666-4666-8666-666666666666";
const REF = "77777777-7777-4777-8777-777777777777";

function snapshot(): ExportSnapshot {
  return {
    version: 1,
    exportedAt: "2027-01-05T00:00:00.000Z",
    sections: [{ id: SECTION, code: "LIF", name: "Life", order: 1 }],
    shelves: [{ id: SHELF, sectionId: SECTION, code: "GTH", name: "Gatherings", description: "Parties.", order: 1 }],
    projects: [],
    tags: [
      { id: TAG, slug: "christmas", colour: "#b3162f" },
      { id: OTHER_TAG, slug: "family", colour: "#6f9a7e" },
    ],
    sources: [
      {
        id: SOURCE,
        kind: "conversation",
        uri: null,
        label: "session of 2026-12-27",
        occurredAt: null,
        trust: "stated",
        createdAt: "2026-12-27T10:00:00.000Z",
      },
    ],
    memories: [
      {
        id: MEMORY,
        callNumber: "LIF/GTH/2026-12-24/001",
        shelfId: SHELF,
        occurredOn: "2026-12-24",
        seq: 1,
        kind: "episode",
        scope: "global",
        scopeRef: null,
        title: "Christmas at home",
        body: "Hosted Christmas with Jane Doe.",
        why: null,
        howToApply: null,
        importance: 3,
        trust: "stated",
        state: "active",
        validFrom: "2026-12-24T00:00:00.000Z",
        validTo: null,
        supersededById: null,
        pinned: false,
        lastConfirmedAt: "2026-12-27T10:00:00.000Z",
        lastRecalledAt: null,
        recallCount: 0,
        createdAt: "2026-12-27T10:00:00.000Z",
        updatedAt: "2026-12-27T10:00:00.000Z",
        tagIds: [TAG, OTHER_TAG],
        refs: [{ id: REF, role: "attendee", uri: null, label: "Jane Doe", resolved: false }],
        sources: [{ sourceId: SOURCE, quote: "everyone over" }],
      },
    ],
    versions: [],
    aliases: [{ oldCallNumber: "LIF/GTH/2026-12-23/001", memoryId: null, createdAt: "2026-12-27T10:00:00.000Z" }],
    links: [],
  };
}

describe("diffSnapshots", () => {
  it("finds nothing between a snapshot and itself, or a reordered copy", () => {
    const left = snapshot();
    const right = snapshot();
    right.tags.reverse();
    right.memories[0]!.tagIds.reverse();
    expect(diffSnapshots(left, right).identical).toBe(true);
  });

  it("ignores the exportedAt stamp", () => {
    const right = snapshot();
    right.exportedAt = "2030-01-01T00:00:00.000Z";
    expect(diffSnapshots(snapshot(), right).identical).toBe(true);
  });

  it("matches sections, shelves and tags by code, path and slug, not by id", () => {
    const right = snapshot();
    const shelfId = "88888888-8888-4888-8888-888888888888";
    right.sections[0]!.id = "99999999-9999-4999-8999-999999999999";
    right.shelves[0] = { ...right.shelves[0]!, id: shelfId, sectionId: right.sections[0]!.id };
    right.memories[0]!.shelfId = shelfId;
    expect(diffSnapshots(snapshot(), right).identical).toBe(true);
    expect(keyedView(right).memories[0]).toMatchObject({ shelf: "LIF/GTH", tags: ["christmas", "family"] });
  });

  it("reports a missing row, an extra row and a changed field, nested ones included", () => {
    const right = snapshot();
    right.aliases = [];
    right.links.push({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", fromId: MEMORY, toId: MEMORY, relation: "elaborates", createdAt: "2027-01-01T00:00:00.000Z" });
    right.memories[0]!.title = "Christmas";
    right.memories[0]!.refs[0]!.label = "Jane";
    right.memories[0]!.tagIds = [TAG];

    const diff = diffSnapshots(snapshot(), right);
    expect(diff.identical).toBe(false);
    const by = (name: string) => diff.collections.find((c) => c.collection === name)!;
    expect(by("aliases").missing).toEqual(["LIF/GTH/2026-12-23/001"]);
    expect(by("links").extra).toEqual([`${MEMORY}|${MEMORY}|elaborates`]);
    expect(by("memories").changed[0]!.fields.map((f) => f.path).sort()).toEqual(["refs.77777777-7777-4777-8777-777777777777.label", "tags", "title"]);
    expect(diff.problems.map((p) => p.collection).sort()).toEqual(["aliases", "links", "memories"]);

    const report = formatDiff(diff);
    expect(report).toContain("aliases");
    expect(report).toContain("is gone");
    expect(report).toContain("appeared");
    expect(report).not.toMatch(/[\u2013\u2014]/);
  });

  it("treats a null and a value as different, and skips an ignored collection", () => {
    const right = snapshot();
    right.memories[0]!.why = "It matters.";
    right.aliases = [];
    const diff = diffSnapshots(snapshot(), right, { ignore: ["aliases"] });
    expect(diff.problems.map((p) => p.collection)).toEqual(["memories"]);
  });
});
