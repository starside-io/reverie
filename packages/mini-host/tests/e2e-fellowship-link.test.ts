import { randomUUID } from "node:crypto";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";

import { PACKAGE_ROOT } from "./fixtures/children.js";
import { envFor, throwawayDir } from "./harness.js";

/**
 * The milestone's own test (docs/SPEC.md section 23, M5), from Reverie's side:
 * one telling of a party yields an occasion and an episode that point at each
 * other. The real MCP server runs in its own process over stdio. The people
 * module is a small stand-in written here, following the shared contract:
 * people_resolve_person, people_log_interaction (with refs) and
 * people_update_interaction ({ eventId, patch: { refs } }, refs replacing the
 * whole list). The test plays the assistant, the one thing that sees both
 * tool sets: Reverie never calls the stand-in, and the stand-in never calls
 * Reverie. All data is invented.
 */

type Content = { content?: Array<{ type: string; text?: string }>; isError?: boolean };

function payloadOf<T>(result: unknown): T {
  const text = ((result as Content).content ?? []).find((entry) => entry.type === "text")?.text ?? "";
  if ((result as Content).isError) throw new Error(text);
  return JSON.parse(text) as T;
}

interface OutsideRef {
  uri: string;
  label: string;
}

/** A stand-in for the people module's tools, by the contract. In memory, in this process. */
function peopleStandIn() {
  const people = [
    { id: randomUUID(), displayName: "Jane Doe" },
    { id: randomUUID(), displayName: "John Doe" },
    { id: randomUUID(), displayName: "Sam Rivera" },
  ];
  const events = new Map<
    string,
    { id: string; title: string; type: string; occurredAt: string; personIds: string[]; refs: OutsideRef[] }
  >();
  const notes: Array<{ personId: string; body: unknown }> = [];
  const byName = (name: string) => people.find((person) => person.displayName.toLowerCase() === name.trim().toLowerCase());

  return {
    people,
    events,
    notes,
    people_resolve_person({ name }: { name: string }) {
      const match = byName(name);
      return match ? { status: "unique" as const, match: { id: match.id, displayName: match.displayName }, candidates: [] } : { status: "none" as const, match: null, candidates: [] };
    },
    people_log_interaction(input: {
      title: string;
      type: string;
      occurredAt: string;
      participants: Array<{ personId?: string; name?: string; sentiment?: number }>;
      refs?: OutsideRef[];
    }) {
      const personIds: string[] = [];
      const unmatched: string[] = [];
      for (const participant of input.participants) {
        expect(participant).not.toHaveProperty("sentiment");
        const id = participant.personId ?? (participant.name ? byName(participant.name)?.id : undefined);
        if (id) personIds.push(id);
        else unmatched.push(participant.name ?? "");
      }
      if (unmatched.length > 0) return { written: false as const, unmatched };
      const event = {
        id: randomUUID(),
        title: input.title,
        type: input.type,
        occurredAt: `${input.occurredAt.slice(0, 10)}T00:00:00.000Z`,
        personIds,
        refs: [...(input.refs ?? [])],
      };
      events.set(event.id, event);
      return { written: true as const, event: { id: event.id, title: event.title, occurredAt: event.occurredAt, refs: event.refs }, personIds };
    },
    people_update_interaction(input: { eventId: string; patch: { refs?: OutsideRef[] } }) {
      const event = events.get(input.eventId);
      if (!event) throw new Error("not_found");
      if (input.patch.refs) event.refs = [...input.patch.refs];
      return { written: true as const, event };
    },
    people_add_note(input: { personId: string; body: unknown }) {
      notes.push(input);
      return { note: { id: randomUUID() } };
    },
  };
}

describe("one telling of a party, over stdio, with a people module stand-in", () => {
  it("yields an occasion and an episode that point at each other, told and inferred", async () => {
    const dir = throwawayDir();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "src/mcp.ts"],
      cwd: PACKAGE_ROOT,
      env: { ...(envFor(dir) as Record<string, string>), REVERIE_SESSION_ID: "session-e2e-m5" },
      stderr: "pipe",
    });
    const client = new Client({ name: "test-assistant", version: "0.0.1" });
    const errors: Error[] = [];
    client.onerror = (error) => errors.push(error);
    const fellowship = peopleStandIn();
    const memory = async <T>(name: string, args: Record<string, unknown>) => payloadOf<T>(await client.callTool({ name, arguments: args }));

    await client.connect(transport);
    try {
      const listed = await client.listTools();
      expect(listed.tools).toHaveLength(41);
      // Detection by tools: memory_* here, people_* on the stand-in.
      expect(listed.tools.every((tool) => tool.name.startsWith("memory_"))).toBe(true);

      /* ---------- The owner told it: occasion first, then the memory. */

      const names = ["Jane Doe", "John Doe", "Sam Rivera"];
      const resolved = names.map((name) => fellowship.people_resolve_person({ name }).match!);
      const logged = fellowship.people_log_interaction({
        title: "Christmas at home",
        type: "PARTY",
        occurredAt: "2026-12-24",
        participants: resolved.map((person) => ({ personId: person.id })),
      });
      expect(logged.written).toBe(true);
      const eventId = (logged as { event: { id: string } }).event.id;

      const told = await memory<{
        memory: { call: string; title: string; occasion: { uri: string }; attendees: Array<{ uri: string; label: string }> };
        backRef: { tool: string; input: { eventId: string; patch: { refs: OutsideRef[] } } };
      }>("memory_remember", {
        kind: "episode",
        shelf: "LIF/GTH",
        occurredOn: "2026-12-24",
        title: "Christmas at home",
        body: "Hosted Christmas. The oven died mid afternoon, so we ordered pizza.",
        tags: ["christmas", "hosting"],
        attendees: resolved.map((person) => ({ uri: `module://people/person/${person.id}`, label: person.displayName })),
        occasion: { uri: `module://people/event/${eventId}`, label: "Christmas at home, 2026-12-24" },
      });
      expect(told.memory.occasion.uri).toBe(`module://people/event/${eventId}`);
      expect(told.memory.attendees.map((ref) => ref.label)).toEqual(names);

      // The back reference, merged with the refs the occasion carries now.
      expect(told.backRef.tool).toBe("people.update_interaction");
      const current = fellowship.events.get(eventId)!.refs;
      fellowship.people_update_interaction({
        eventId: told.backRef.input.eventId,
        patch: { refs: [...current, ...told.backRef.input.patch.refs.filter((ref) => !current.some((c) => c.uri === ref.uri))] },
      });
      expect(fellowship.events.get(eventId)!.refs).toEqual([
        { uri: `module://memory/memory/${told.memory.call}`, label: "Christmas at home" },
      ]);

      /* ---------- A model inferred it: one Reverie proposal, the occasion riding inside. */

      const telling =
        "On 2026-12-26 we had a boxing day walk to the Elmwood lighthouse with Jane Doe and Sam Rivera. The thermos leaked everywhere. Sam Rivera has started a new job.";
      const context = await memory<{ target: Record<string, unknown> }>("memory_draft_context", {
        job: "extract",
        material: { kind: "turns", turns: [{ role: "user", text: telling }] },
        sessionDate: "2026-12-27",
      });
      const proposed = await memory<{ queued: Array<{ id: string }>; rejected: unknown[] }>("memory_propose_draft", {
        target: context.target,
        draft: {
          candidates: [
            {
              kind: "episode",
              title: "Boxing day walk",
              body: "Walked to the Elmwood lighthouse. The thermos leaked everywhere.",
              shelf: "LIF/GTH",
              occurredOn: "2026-12-26",
              tags: ["walk"],
              people: [{ name: "Jane Doe" }, { name: "Sam Rivera" }],
              occasion: { title: "Boxing day walk", type: "HANGOUT" },
              notes: [{ person: "Sam Rivera", body: "Started a new job in December 2026." }],
              quote: "The thermos leaked everywhere.",
            },
          ],
        },
      });
      expect(proposed.rejected).toEqual([]);

      const review = await memory<{ groups: Array<{ title: string; steps: Array<{ part: string; tool: string }> }> }>("memory_review", {});
      expect(review.groups[0]?.title).toBe("Boxing day walk, 2026-12-26");
      expect(review.groups[0]?.steps.map((step) => step.part)).toEqual(["occasion", "memory", "note"]);

      const decided = await memory<{
        committed: { call: string };
        followUp: {
          tool: string;
          input: { title: string; type: string; occurredAt: string; participants: Array<{ name: string }>; refs: OutsideRef[] };
          then: { tool: string; call: string };
        };
        noteFollowUps: Array<{ tool: string; input: { personId: string | null; body: unknown }; resolveFirst: { input: { name: string } } | null }>;
      }>("memory_decide", { proposalId: proposed.queued[0]!.id, decision: "confirm", confirmedByUser: true });

      const call = decided.committed.call;
      expect(decided.followUp).toEqual({
        tool: "people.log_interaction",
        input: {
          title: "Boxing day walk",
          type: "HANGOUT",
          occurredAt: "2026-12-26",
          participants: [{ name: "Jane Doe" }, { name: "Sam Rivera" }],
          refs: [{ uri: `module://memory/memory/${call}`, label: "Boxing day walk" }],
        },
        then: { tool: "memory.link_occasion", call },
      });

      // No second occasion on a retry: nothing on that day with those people yet, so log it.
      const sameDay = [...fellowship.events.values()].filter((event) => event.occurredAt.startsWith("2026-12-26"));
      expect(sameDay).toEqual([]);
      const second = fellowship.people_log_interaction(decided.followUp.input);
      expect(second.written).toBe(true);
      const walk = (second as { event: { id: string; refs: OutsideRef[] }; personIds: string[] }).event;
      expect(walk.refs).toEqual([{ uri: `module://memory/memory/${call}`, label: "Boxing day walk" }]);

      const linked = await memory<{ memory: { occasion: { uri: string }; attendees: Array<{ uri: string | null }> }; resolvedNames: string[] }>(
        "memory_link_occasion",
        {
          call: decided.followUp.then.call,
          occasion: `module://people/event/${walk.id}`,
          label: "Boxing day walk, 2026-12-26",
          participants: (second as { personIds: string[] }).personIds.map((id) => ({
            uri: `module://people/person/${id}`,
            label: fellowship.people.find((person) => person.id === id)!.displayName,
          })),
        },
      );
      expect(linked.memory.occasion.uri).toBe(`module://people/event/${walk.id}`);
      expect(linked.resolvedNames).toEqual(["Jane Doe", "Sam Rivera"]);
      expect(linked.memory.attendees.every((ref) => ref.uri?.startsWith("module://people/person/"))).toBe(true);

      // The note rides to the people module once Sam is resolved.
      const note = decided.noteFollowUps[0]!;
      const sam = fellowship.people_resolve_person({ name: note.resolveFirst!.input.name }).match!;
      fellowship.people_add_note({ ...note.input, personId: sam.id });
      expect(fellowship.notes).toHaveLength(1);

      // The front desk is clear: nothing pending, no occasion without its story.
      const after = await memory<{ frontDesk: { occasionPending: unknown[]; occasionsWithNoStory: unknown[] } }>("memory_review", {});
      expect(after.frontDesk.occasionPending).toEqual([]);

      // Each side points at the other.
      const got = await memory<{ memory: { occasion: { uri: string } } }>("memory_get", { call });
      expect(got.memory.occasion.uri).toBe(`module://people/event/${walk.id}`);
      expect(fellowship.events.get(walk.id)!.refs[0]!.uri).toBe(`module://memory/memory/${call}`);
    } finally {
      await client.close();
    }
    expect(errors).toEqual([]);
  });
});
