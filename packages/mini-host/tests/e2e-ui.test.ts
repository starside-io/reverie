import { describe, expect, it } from "vitest";

import { serveMiniHost } from "../src/server.js";
import { filesIn, throwawayDir } from "./harness.js";

/**
 * M6, done when: shelve, tag, review and forget without touching SQL
 * (docs/SPEC.md section 23). This drives a real host on a real socket over a
 * throwaway silo with the same calls the UI in packages/ui makes, in the same
 * shape its client sends them: POST /rpc as JSON from the host's own origin,
 * and the owner's decision on a proposal through POST /host/review/:id/:decision.
 *
 *   remember   the Remember dialog (library)      memory.remember
 *   shelve     the Shelve dialog (memory page)    memory.shelve { action: "move" }
 *   tag        the tag field (memory page)        memory.set_tags { action: "memory" }
 *   review     Confirm (review screen)            memory.review, then /host/review/:id/confirm
 *   forget     Forget (memory page)               memory.forget { confirmedByUser: true }
 *
 * The proposal itself is queued the way an assistant queues one,
 * memory.draft_context then memory.propose_draft. Every name is invented.
 */

type Json = Record<string, unknown>;

describe("the UI's calls, end to end on a throwaway silo", () => {
  it("remembers, shelves to another shelf, tags, confirms a proposal and forgets", async () => {
    const running = await serveMiniHost({ ...filesIn(throwawayDir()), port: 0, lock: false });
    const origin = running.url;

    // As packages/ui/src/client.ts sends it, from the page the host served.
    const rpc = async <T = Json>(tool: string, input: unknown = {}): Promise<T> => {
      const response = await fetch(`${origin}/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json", origin, "sec-fetch-site": "same-origin" },
        body: JSON.stringify({ tool, input }),
      });
      const body = (await response.json()) as { ok: boolean; result?: T; error?: { code: string; message: string; detail?: unknown } };
      if (!body.ok) throw Object.assign(new Error(body.error?.message), { code: body.error?.code, detail: body.error?.detail });
      return body.result as T;
    };
    const decide = async (id: string, decision: "confirm" | "reject") => {
      const response = await fetch(`${origin}/host/review/${encodeURIComponent(id)}/${decision}`, {
        method: "POST",
        headers: { origin, "sec-fetch-site": "same-origin" },
      });
      return { status: response.status, body: (await response.json()) as Json };
    };

    try {
      // The library the home screen draws.
      const shelves = await rpc<{ sections: Array<{ code: string; shelves: Array<{ path: string }> }> }>("memory.shelves");
      const paths = shelves.sections.flatMap((section) => section.shelves.map((shelf) => shelf.path));
      expect(paths).toEqual(expect.arrayContaining(["LIF/GTH", "LIF/TRV", "DSK/RET"]));

      // Remember.
      const remembered = await rpc<{ memory: { call: string } }>("memory.remember", {
        body: "Hosted Christmas for Jane Doe and John Doe at the Elmwood cottage. The oven died, so we ordered pizza.",
        kind: "episode",
        occurredOn: "2026-12-24",
        shelf: "LIF/GTH",
        tags: ["christmas"],
        attendees: ["Jane Doe", "John Doe"],
      });
      const first = remembered.memory.call;
      expect(first).toBe("LIF/GTH/2026-12-24/001");
      const gatherings = await rpc<{ items: Array<{ call: string }> }>("memory.browse", {
        shelf: "LIF/GTH",
        order: "asc",
        includeRetired: false,
        limit: 50,
      });
      expect(gatherings.items.map((item) => item.call)).toEqual([first]);

      // Shelve to another shelf: a new number, the old one kept as an alias.
      const moved = await rpc<{ action: string; from: string; to: string }>("memory.shelve", {
        action: "move",
        call: first,
        shelf: "LIF/TRV",
      });
      expect(moved).toMatchObject({ action: "move", from: first, to: "LIF/TRV/2026-12-24/001" });
      const viaOld = await rpc<{ moved: boolean; memory: { call: string; aliases: string[] } }>("memory.get", { call: first });
      expect(viaOld.moved).toBe(true);
      expect(viaOld.memory.call).toBe(moved.to);
      expect(viaOld.memory.aliases).toEqual([first]);
      expect((await rpc<{ items: unknown[] }>("memory.browse", { shelf: "LIF/GTH" })).items).toEqual([]);

      // Tag, and untag.
      const tagged = await rpc<{ tags: string[]; changed: boolean }>("memory.set_tags", {
        action: "memory",
        call: moved.to,
        attach: ["family", "hosting"],
      });
      expect(tagged).toMatchObject({ changed: true, tags: ["christmas", "family", "hosting"] });
      const untagged = await rpc<{ tags: string[] }>("memory.set_tags", { action: "memory", call: moved.to, detach: ["hosting"] });
      expect(untagged.tags).toEqual(["christmas", "family"]);
      const vocabulary = await rpc<{ tags: Array<{ slug: string; count: number }> }>("memory.tags");
      expect(vocabulary.tags.find((tag) => tag.slug === "family")?.count).toBe(1);

      // Review: an assistant proposes, the owner confirms on the review screen.
      const said = "We met Sam Rivera for coffee at the station cafe in Elmwood.";
      const context = await rpc<{ target: unknown }>("memory.draft_context", {
        job: "extract",
        material: { kind: "turns", turns: [{ role: "user", text: said }] },
        sessionDate: "2026-12-27",
      });
      await rpc("memory.propose_draft", {
        target: context.target,
        draft: {
          candidates: [
            {
              kind: "episode",
              title: "Coffee with Sam",
              body: "Met Sam Rivera for coffee at the station cafe in Elmwood.",
              shelf: "LIF/GTH",
              occurredOn: "2026-12-27",
              tags: ["coffee"],
              people: [{ name: "Sam Rivera" }],
              occasion: null,
              quote: said,
            },
          ],
        },
      });
      const waiting = await rpc<{
        proposals: Array<{ id: string; tool: string; payload: { shelf: string; draft: { quote: string } }; group: { title: string } }>;
      }>("memory.review", { state: "pending" });
      expect(waiting.proposals).toHaveLength(1);
      const proposal = waiting.proposals[0]!;
      // What the review screen shows: the verb's tool, the proposed shelf, the quote, the group.
      expect(proposal).toMatchObject({ tool: "memory.remember", payload: { shelf: "LIF/GTH", draft: { quote: said } } });
      expect(proposal.group.title).toBe("Session of 2026-12-27");

      const confirmed = await decide(proposal.id, "confirm");
      expect(confirmed.status).toBe(200);
      expect(confirmed.body).toMatchObject({ ok: true, state: "confirmed", committed: { call: "LIF/GTH/2026-12-27/001" } });
      const shelvedProposal = await rpc<{ memory: { trust: string; title: string } }>("memory.get", { call: "LIF/GTH/2026-12-27/001" });
      expect(shelvedProposal.memory).toMatchObject({ trust: "confirmed", title: "Coffee with Sam" });
      expect((await rpc<{ proposals: unknown[] }>("memory.review", { state: "pending" })).proposals).toEqual([]);

      // A page on another origin cannot forget it for the owner.
      const forged = await fetch(`${origin}/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://pages.example" },
        body: JSON.stringify({ tool: "memory.forget", input: { call: moved.to, confirmedByUser: true } }),
      });
      expect(forged.status).toBe(403);
      expect((await rpc<{ memory: { call: string } }>("memory.get", { call: moved.to })).memory.call).toBe(moved.to);

      // Forget, from the memory page: the number and its alias go for good.
      const forgotten = await rpc<{ forgotten: { call: string; retiredNumbers: string[] } }>("memory.forget", {
        call: moved.to,
        confirmedByUser: true,
      });
      expect(forgotten.forgotten.call).toBe(moved.to);
      expect([...forgotten.forgotten.retiredNumbers].sort()).toEqual([first, moved.to].sort());
      for (const call of [moved.to, first]) {
        const gone = await rpc("memory.get", { call }).catch((error: { code: string; detail: { forgotten: boolean } }) => error);
        expect(gone).toMatchObject({ code: "not_found", detail: { forgotten: true } });
      }
      const after = await rpc<{ tags: Array<{ slug: string }> }>("memory.tags");
      expect(after.tags.map((tag) => tag.slug)).not.toContain("family");
    } finally {
      await running.close();
    }
  });
});
