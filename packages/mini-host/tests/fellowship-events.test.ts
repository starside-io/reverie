import { describe, expect, it } from "vitest";

import { MEMORY_URI_PREFIX } from "../src/ports/index.js";
import { remember, throwawayHost } from "./harness.js";

/**
 * The three people events of docs/SPEC.md section 18, delivered by this host
 * (host.publish), in the payload shapes Fellowship emits, against a real
 * silo and host.db. And the memory side of "a memory is forgotten": the link
 * back from Fellowship's occasion answers unavailable. All data is invented.
 */

const OCCASION = "module://people/event/e_8812";

describe("people events delivered by the mini-host", () => {
  it("people.interaction.logged lists the occasion in host.db; a story attaches to it; it leaves the list", async () => {
    const host = await throwawayHost();
    try {
      const result = await host.publish("people.interaction.logged", {
        eventId: "e_8812",
        personIds: ["p_jane"],
        occurredAt: "2026-12-24T00:00:00.000Z",
      });
      expect(result).toMatchObject({ handled: true, detail: { occasion: OCCASION, listed: true } });
      expect(host.store.readValue("people.occasionsWithNoStory")).toMatchObject([{ occasion: OCCASION, occurredOn: "2026-12-24" }]);
      let review = (await host.api.invoke("memory.review", {})) as { frontDesk: { occasionsWithNoStory: unknown[] } };
      expect(review.frontDesk.occasionsWithNoStory).toHaveLength(1);

      await remember(host, {
        kind: "episode",
        shelf: "LIF/GTH",
        occurredOn: "2026-12-24",
        body: "Hosted Christmas at the Elmwood flat.",
        attendees: [{ uri: "module://people/person/p_jane", label: "Jane Doe" }],
        occasion: { uri: OCCASION, label: "Christmas at home, 2026-12-24" },
      });
      review = (await host.api.invoke("memory.review", {})) as { frontDesk: { occasionsWithNoStory: unknown[] } };
      expect(review.frontDesk.occasionsWithNoStory).toEqual([]);
    } finally {
      await host.close();
    }
  });

  it("people.person.created queues a resolution in the host's review queue", async () => {
    const host = await throwawayHost();
    try {
      const made = await remember(host, { kind: "episode", shelf: "LIF/GTH", body: "Coffee by the harbour.", attendees: ["Sam Rivera"] });
      const result = await host.publish("people.person.created", { personId: "p_sam", displayName: "Sam Rivera" });
      expect(result).toMatchObject({ handled: true, detail: { proposed: 1, matches: [made.memory.call] } });
      expect(host.store.listProposals("pending")).toMatchObject([{ tool: "memory.update", memoryId: made.memory.id }]);
    } finally {
      await host.close();
    }
  });

  it("people.interaction.changed syncs attendees, then marks the occasion unavailable when removed", async () => {
    const host = await throwawayHost();
    try {
      const made = await remember(host, {
        kind: "episode",
        shelf: "LIF/GTH",
        occurredOn: "2026-12-24",
        body: "Hosted Christmas at the Elmwood flat.",
        attendees: ["Jane Doe"],
        occasion: { uri: OCCASION, label: "Christmas at home" },
      });
      await host.publish("people.interaction.changed", {
        eventId: "e_8812",
        change: "participants",
        occurredAt: "2026-12-24T00:00:00.000Z",
        title: "Christmas at home",
        participants: [{ personId: "p_jane", name: "Jane Doe" }],
      });
      let got = (await host.api.invoke("memory.get", { call: made.memory.call })) as {
        memory: { body: string; attendees: Array<{ uri: string | null }>; occasion: { status: string } };
      };
      expect(got.memory.attendees.map((ref) => ref.uri)).toEqual(["module://people/person/p_jane"]);

      await host.publish("people.interaction.changed", { eventId: "e_8812", change: "removed", occurredAt: null, title: null, participants: [] });
      got = (await host.api.invoke("memory.get", { call: made.memory.call })) as typeof got;
      expect(got.memory.occasion.status).toBe("unavailable");
      expect(got.memory.body).toBe("Hosted Christmas at the Elmwood flat.");
    } finally {
      await host.close();
    }
  });

  it("a forgotten memory: the link back answers unavailable, and the occasion is not Reverie's to touch", async () => {
    const host = await throwawayHost();
    try {
      const made = await remember(host, {
        kind: "episode",
        shelf: "LIF/GTH",
        occurredOn: "2026-12-24",
        body: "Hosted Christmas at the Elmwood flat.",
        occasion: { uri: OCCASION, label: "Christmas at home" },
      });
      const back = `${MEMORY_URI_PREFIX}${made.memory.call}`;
      expect(await host.ports.refs.resolve(back)).toMatchObject({ status: "resolved" });
      await host.api.invoke("memory.forget", { call: made.memory.call, confirmedByUser: true });
      expect(await host.ports.refs.resolve(back)).toMatchObject({ status: "unavailable" });
      expect(await host.ports.refs.resolve(`${MEMORY_URI_PREFIX}${made.memory.id}`)).toMatchObject({ status: "unavailable" });
    } finally {
      await host.close();
    }
  });
});
