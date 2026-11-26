import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Prisma } from "../../generated/prisma/index.js";
import type { Confirmed } from "./harness.js";
import { PEOPLE, type TestHost } from "../test-host.js";
import { candidate, draft, gateHost, SESSION_DATE, siloText, turns } from "./harness.js";

/**
 * Gate: Reverie never stores a score or a sentiment about a person
 * (docs/SPEC.md section 8, "Division of authority": how it went between us
 * is Fellowship's, "the memory never stores a score").
 *
 * Structural: no column of the silo can hold one. Behavioural: every input
 * that takes a person refuses a score or a sentiment with the reason; an
 * event payload carrying one leaves nothing of it behind; a follow up for the
 * people module never carries one.
 */

const SCORE_COLUMN = /score|sentiment|closeness|rating|affinity|mood/i;

describe("never a score about a person", () => {
  let host: TestHost;

  beforeEach(async () => {
    host = await gateHost();
  });
  afterEach(async () => {
    await host.close();
  });

  it("no table in the silo has a column for one, and MemoryRef holds exactly role, uri, label and resolved", () => {
    const models = Prisma.dmmf.datamodel.models;
    for (const model of models) {
      // RecallLog.scores is recall's own ranking of memories, never a person's.
      const columns = model.fields.filter((field) => field.kind === "scalar").map((field) => field.name);
      const suspicious = columns.filter((name) => SCORE_COLUMN.test(name) && !(model.name === "RecallLog" && name === "scores"));
      expect(suspicious, model.name).toEqual([]);
    }
    const ref = models.find((model) => model.name === "MemoryRef")!;
    expect(ref.fields.filter((field) => field.kind === "scalar").map((field) => field.name).sort()).toEqual(
      ["id", "label", "memoryId", "resolved", "role", "uri"].sort(),
    );
  });

  it("remember, supersede, update and link_occasion refuse a sentiment on a person, saying where it belongs", async () => {
    const withScore = { uri: PEOPLE.sam.uri, label: "Sam Rivera", sentiment: 2 };
    const refused = await host
      .invoke("memory.remember", { kind: "episode", body: "Hosted Christmas.", attendees: [withScore] })
      .catch((error: { code?: string; message?: string; detail?: unknown }) => error);
    expect(refused).toMatchObject({ code: "invalid_input" });
    expect(JSON.stringify(refused)).toContain("never stores a score");
    await expect(
      host.invoke("memory.remember", { kind: "episode", body: "Hosted Christmas.", mentions: [{ uri: PEOPLE.sam.uri, closeness: 0.9 }] }),
    ).rejects.toMatchObject({ code: "invalid_input" });

    const made = await host.invoke<{ memory: { call: string } }>("memory.remember", {
      kind: "episode",
      body: "Hosted Christmas.",
      attendees: ["Sam Rivera"],
    });
    await expect(
      host.invoke("memory.update", { call: made.memory.call, people: [{ ...withScore, name: "Sam Rivera" }] }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      host.invoke("memory.link_occasion", {
        call: made.memory.call,
        occasion: "module://people/event/e_8812",
        participants: [{ uri: PEOPLE.sam.uri, label: "Sam Rivera", score: 5 }],
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      host.invoke("memory.supersede", {
        call: made.memory.call,
        body: "Hosted Christmas for four.",
        attendees: [{ uri: PEOPLE.sam.uri, rating: 4 }],
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("a people event carrying a sentiment leaves nothing of it in the silo", async () => {
    await host.invoke("memory.remember", {
      kind: "episode",
      shelf: "LIF/GTH",
      occurredOn: "2026-12-24",
      body: "Hosted Christmas.",
      attendees: ["Sam Rivera"],
      occasion: { uri: "module://people/event/e_8812", label: "Christmas at home" },
    });
    await host.api.deliver("people.interaction.changed", {
      eventId: "e_8812",
      change: "participants",
      occurredAt: "2026-12-24T00:00:00.000Z",
      title: "Christmas at home",
      sentiment: -2,
      participants: [{ personId: "p_sam", name: "Sam Rivera", sentiment: -2, score: 0.1 }],
    });
    const text = await siloText(host);
    expect(text).not.toMatch(/sentiment|closeness|"score"/);
    expect(await host.db.memoryRef.findFirst({ where: { uri: PEOPLE.sam.uri } })).toMatchObject({ label: "Sam Rivera" });
  });

  it("the follow up for the people module carries no sentiment, even for a telling that said how it went", async () => {
    const telling = "Christmas on 2026-12-24 with Sam Rivera was lovely. The oven died so we ordered pizza.";
    const proposed = await draft(
      host,
      { job: "extract", material: turns(telling), sessionDate: SESSION_DATE },
      {
        candidates: [
          candidate({
            kind: "episode",
            title: "Christmas at home",
            body: "Hosted Christmas. The oven died, so we ordered pizza.",
            shelf: "LIF/GTH",
            occurredOn: "2026-12-24",
            people: [{ name: "Sam Rivera" }],
            occasion: { title: "Christmas at home", type: "PARTY" },
            quote: "The oven died so we ordered pizza.",
          }),
        ],
      },
    );
    const decided = await host.invoke<Confirmed>("memory.decide", {
      proposalId: proposed.queued[0]!.id,
      decision: "confirm",
      confirmedByUser: true,
    });
    expect(JSON.stringify(decided.followUp)).not.toMatch(/sentiment|score|closeness|weight/);
    expect(decided.followUp?.input.participants).toEqual([{ name: "Sam Rivera" }]);
  });

  it("a draft cannot carry one on a person either", async () => {
    const proposed = await draft(
      host,
      { job: "extract", material: turns("Coffee with Sam Rivera on 2026-12-20."), sessionDate: SESSION_DATE },
      {
        candidates: [
          candidate({
            kind: "episode",
            body: "Coffee with Sam.",
            occurredOn: "2026-12-20",
            people: [{ name: "Sam Rivera", sentiment: 2 } as never],
            quote: "Coffee with Sam Rivera on 2026-12-20.",
          }),
        ],
      },
    ).catch((error: { code?: string }) => error);
    expect((proposed as { code?: string }).code).toBe("invalid_input");
  });
});
