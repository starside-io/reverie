import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RememberResult } from "../../../src/tools/write/remember.js";
import type { SupersedeToolResult } from "../../../src/tools/write/supersede.js";
import { testHost, type TestHost } from "../../test-host.js";

/**
 * A project memory given no shelf lands on its project's shelf, not on
 * Returns (docs/SPEC.md sections 4 and 5): the project resolved from the
 * session, or named by scopeRef. Through every door that makes a memory:
 * remember, promote_procedure, supersede, and a drafted proposal. Invented
 * projects and people only.
 */

const NOW = new Date("2026-11-26T10:00:00.000Z");

describe("a project memory with no shelf", () => {
  let host: TestHost;

  beforeEach(async () => {
    host = await testHost({ now: NOW, session: { id: "session-1", folder: "/work/maple-street/app" } });
    const nst = await host.db.shelf.findFirstOrThrow({ where: { code: "NST", section: { code: "WRK" } } });
    const flw = await host.db.shelf.findFirstOrThrow({ where: { code: "FLW", section: { code: "WRK" } } });
    await host.db.project.create({ data: { slug: "maple-street", name: "Maple Street", shelfId: nst.id } });
    await host.db.project.create({ data: { slug: "elmwood", name: "Elmwood", shelfId: flw.id } });
    await host.db.project.create({ data: { slug: "no-home", name: "No Home" } });
    host.localPaths.push({ project: "maple-street", path: "/work/maple-street" });
  });
  afterEach(async () => {
    await host.close();
  });

  const remember = (input: Record<string, unknown>) =>
    host.invoke<RememberResult>("memory.remember", { kind: "fact", ...input });

  it("lands on the project's shelf, resolved from the session", async () => {
    const result = await remember({ body: "Jane Doe reviews the seed orders.", scope: "project" });
    expect(result.memory).toMatchObject({ scope: "project", scopeRef: "maple-street", shelf: "WRK/NST" });
    expect(result.memory.call.startsWith("WRK/NST/")).toBe(true);
    expect(result.landedOnReturns).toBe(false);
    expect(result.notice).toBeNull();
  });

  it("lands on the shelf of the project scopeRef names, from any folder", async () => {
    host.session = { id: "session-2", folder: "/elsewhere" };
    const result = await remember({ body: "John Doe keeps the tool shed rota.", scope: "project", scopeRef: "elmwood" });
    expect(result.memory).toMatchObject({ scopeRef: "elmwood", shelf: "WRK/FLW" });
  });

  it("keeps a shelf it was given, and waits on Returns when the project has no shelf", async () => {
    const given = await remember({ body: "Sam Rivera fixed the gate hinge.", scope: "project", shelf: "LIF/HOM" });
    expect(given.memory.shelf).toBe("LIF/HOM");
    const homeless = await remember({ body: "The No Home project has no shelf yet.", scope: "project", scopeRef: "no-home" });
    expect(homeless.memory.shelf).toBe("DSK/RET");
    expect(homeless.landedOnReturns).toBe(true);
    const global = await remember({ body: "Prefers oat milk in coffee." });
    expect(global.memory.shelf).toBe("DSK/RET");
  });

  it("still refuses a project scope no project answers for", async () => {
    host.session = { id: "session-3", folder: "/elsewhere" };
    await expect(remember({ body: "Something only here.", scope: "project" })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("does the same for a promoted procedure", async () => {
    const result = await host.invoke<{ memory: { shelf: string; scopeRef: string } }>("memory.promote_procedure", {
      title: "Label seed trays",
      body: "Label every seed tray in pencil.",
      why: "Ink runs when the trays are watered.",
      howToApply: "Whenever a tray is sown.",
      scope: "project",
      said: "Label every seed tray in pencil.",
      confirmedByUser: true,
    });
    expect(result.memory).toMatchObject({ shelf: "WRK/NST", scopeRef: "maple-street" });
  });

  it("moves a project entry off Returns when it is superseded, and otherwise keeps the old shelf", async () => {
    const waiting = await host.invoke<RememberResult>("memory.remember", {
      kind: "fact",
      body: "The allotment gate code is held by Jane Doe.",
      scope: "project",
      shelf: "DSK/RET",
    });
    const moved = await host.invoke<SupersedeToolResult>("memory.supersede", {
      call: waiting.memory.call,
      body: "The allotment gate code is held by John Doe now.",
    });
    expect(moved.replacement.shelf).toBe("WRK/NST");
    expect(moved.old.shelf).toBe("DSK/RET");

    const placed = await remember({ body: "Compost goes in the left bay.", scope: "project", shelf: "LIF/HOM" });
    const kept = await host.invoke<SupersedeToolResult>("memory.supersede", {
      call: placed.memory.call,
      body: "Compost goes in the right bay.",
    });
    expect(kept.replacement.shelf).toBe("LIF/HOM");
  });

  it("does the same for a drafted proposal, and says so in review", async () => {
    const said = "Jane Doe wants the north beds kept for tomatoes.";
    const context = await host.invoke<{ target: unknown }>("memory.draft_context", {
      job: "extract",
      material: { kind: "turns", turns: [{ role: "user", text: said }] },
    });
    const proposed = await host.invoke<{ queued: Array<{ id: string; summary: string }> }>("memory.propose_draft", {
      target: context.target,
      draft: {
        candidates: [
          {
            kind: "preference",
            title: "North beds",
            body: said,
            shelf: null,
            occurredOn: "2026-11-26",
            scope: "project",
            tags: [],
            people: [{ name: "Jane Doe" }],
            occasion: null,
            quote: said,
          },
        ],
      },
    });
    expect(proposed.queued).toHaveLength(1);
    expect(proposed.queued[0]?.summary).toContain("on WRK/NST");
    const payload = host.proposals[0]?.payload as { shelf?: string; scopeRef?: string };
    expect(payload).toMatchObject({ shelf: "WRK/NST", scopeRef: "maple-street" });

    const decided = await host.invoke<{ committed: { call: string } }>("memory.decide", {
      proposalId: proposed.queued[0]?.id,
      decision: "confirm",
      confirmedByUser: true,
    });
    expect(decided.committed.call.startsWith("WRK/NST/")).toBe(true);
  });
});
