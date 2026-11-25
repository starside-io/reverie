import type { ExtractCandidateInput } from "../../../src/domain/drafting/schemas.js";
import type { MaterialInput } from "../../../src/domain/drafting/gates.js";

/**
 * Invented material for the drafting tests: the telling from section 8, by
 * the owner, with Jane Doe, John Doe and Sam Rivera.
 */

export const TELLING =
  "I organised Christmas at mine on 2026-12-24 with Jane Doe, John Doe and Sam Rivera. The oven died\nso we ordered pizza. Sam brought his new partner.";

export const TURNS: MaterialInput = {
  kind: "turns",
  turns: [
    { role: "user", text: TELLING },
    { role: "assistant", text: "That sounds like a lively evening." },
  ],
};

export function christmasCandidate(overrides: Partial<ExtractCandidateInput> = {}): ExtractCandidateInput {
  return {
    kind: "episode",
    title: "Christmas at home",
    body: "Hosted Christmas. The oven died mid afternoon, so we ordered pizza.",
    shelf: "LIF/GTH",
    occurredOn: "2026-12-24",
    tags: ["christmas", "#Hosting"],
    people: [{ name: "Jane Doe" }, { name: "John Doe" }, { name: "Sam Rivera" }],
    occasion: { title: "Christmas at home", type: "PARTY" },
    quote: "The oven died so we ordered pizza.",
    ...overrides,
  };
}

export function extractTarget(material: MaterialInput = TURNS) {
  return { job: "extract" as const, material, sessionDate: "2026-12-27" };
}
