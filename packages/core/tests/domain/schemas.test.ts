import { describe, expect, it } from "vitest";

import {
  codeSchema,
  dateOnlySchema,
  importanceSchema,
  memoryCreateSchema,
  normaliseRepoUrl,
  normaliseTagSlug,
  quoteSchema,
  refInputSchema,
  seqSchema,
  shelfRefSchema,
  tagSlugSchema,
} from "../../src/schemas/index.js";
import { episode } from "./library.js";

describe("input schemas", () => {
  it("takes codes of exactly three uppercase letters", () => {
    expect(codeSchema.parse("LIF")).toBe("LIF");
    for (const bad of ["lif", "LI", "LIFE", "L1F", ""]) {
      expect(codeSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("takes a shelf as a path, codes or an id", () => {
    expect(shelfRefSchema.safeParse("WRK/NST").success).toBe(true);
    expect(shelfRefSchema.safeParse({ section: "WRK", shelf: "NST" }).success).toBe(true);
    expect(shelfRefSchema.safeParse("wrk/nst").success).toBe(false);
  });

  it("normalises tags: #NightStash, #nightstash and nightstash are one slug", () => {
    for (const input of ["#NightStash", "#nightstash", "nightstash", "  NIGHTSTASH "]) {
      expect(normaliseTagSlug(input)).toBe("nightstash");
      expect(tagSlugSchema.parse(input)).toBe("nightstash");
    }
  });

  it("refuses a tag outside the slug alphabet or past 64 characters", () => {
    for (const bad of ["", "#", "-lead", "two words", "under_score", "émoji", "a".repeat(65)]) {
      expect(normaliseTagSlug(bad)).toBeNull();
      expect(tagSlugSchema.safeParse(bad).success).toBe(false);
    }
    expect(normaliseTagSlug("a".repeat(64))).toBe("a".repeat(64));
    expect(normaliseTagSlug("night-stash-2")).toBe("night-stash-2");
  });

  it("caps a quote at 500 characters", () => {
    expect(quoteSchema.safeParse("x".repeat(500)).success).toBe(true);
    expect(quoteSchema.safeParse("x".repeat(501)).success).toBe(false);
    expect(quoteSchema.safeParse("   ").success).toBe(false);
  });

  it("holds importance to 1 through 5 and seq to 1 through 999", () => {
    expect(importanceSchema.safeParse(1).success).toBe(true);
    expect(importanceSchema.safeParse(5).success).toBe(true);
    expect(importanceSchema.safeParse(0).success).toBe(false);
    expect(importanceSchema.safeParse(6).success).toBe(false);
    expect(importanceSchema.safeParse(2.5).success).toBe(false);
    expect(seqSchema.safeParse(1).success).toBe(true);
    expect(seqSchema.safeParse(999).success).toBe(true);
    expect(seqSchema.safeParse(0).success).toBe(false);
    expect(seqSchema.safeParse(1000).success).toBe(false);
  });

  it("normalises a date-only value to midnight UTC", () => {
    expect(dateOnlySchema.parse("2026-12-24").toISOString()).toBe("2026-12-24T00:00:00.000Z");
    expect(dateOnlySchema.parse("2026-12-24T21:45:00.000Z").toISOString()).toBe(
      "2026-12-24T00:00:00.000Z",
    );
    expect(dateOnlySchema.parse(new Date(Date.UTC(2026, 11, 24, 23, 59))).toISOString()).toBe(
      "2026-12-24T00:00:00.000Z",
    );
    expect(dateOnlySchema.safeParse("2026-02-31").success).toBe(false);
    expect(dateOnlySchema.safeParse("yesterday").success).toBe(false);
  });

  it("derives resolved from the uri: an unresolved name stays a label", () => {
    expect(refInputSchema.parse({ role: "attendee", label: "Jane Doe" })).toEqual({
      role: "attendee",
      uri: null,
      label: "Jane Doe",
      resolved: false,
    });
    expect(
      refInputSchema.parse({ role: "attendee", label: "Jane Doe", uri: "module://people/person/p1" })
        .resolved,
    ).toBe(true);
    expect(refInputSchema.safeParse({ role: "attendee", label: "J", uri: "https://x" }).success).toBe(
      false,
    );
  });

  it("asks for a source and a consistent scope on a new memory", () => {
    expect(memoryCreateSchema.safeParse(episode()).success).toBe(true);
    expect(memoryCreateSchema.safeParse(episode({ sources: [] })).success).toBe(false);
    expect(memoryCreateSchema.safeParse(episode({ scope: "project" })).success).toBe(false);
    expect(
      memoryCreateSchema.safeParse(episode({ scope: "project", scopeRef: "nightstash" })).success,
    ).toBe(true);
    expect(memoryCreateSchema.safeParse(episode({ scopeRef: "nightstash" })).success).toBe(false);
  });

  it("normalises a repository to host/owner/name", () => {
    expect(normaliseRepoUrl("https://github.com/jane-doe/nightstash.git")).toBe(
      "github.com/jane-doe/nightstash",
    );
    expect(normaliseRepoUrl("git@github.com:jane-doe/nightstash.git")).toBe(
      "github.com/jane-doe/nightstash",
    );
    expect(normaliseRepoUrl("GitHub.com/jane-doe/nightstash/")).toBe("github.com/jane-doe/nightstash");
    expect(normaliseRepoUrl("not a repo")).toBeNull();
  });
});
