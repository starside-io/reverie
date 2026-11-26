import { describe, expect, it } from "vitest";

import {
  backRefCall,
  idOf,
  logInteractionInput,
  memoryUri,
  noteCall,
  readInteractionChanged,
  readInteractionLogged,
  readPersonCreated,
} from "../../src/domain/people-link.js";

/** The one file that knows Fellowship's shapes. All ids and names are invented. */

describe("people-link", () => {
  it("builds and reads the URIs of the contract", () => {
    expect(memoryUri("LIF/GTH/2026-12-24/001")).toBe("module://memory/memory/LIF/GTH/2026-12-24/001");
    expect(idOf("module://people/event/e_8812", "event")).toBe("e_8812");
    expect(idOf("module://people/person/p_sam", "event")).toBeNull();
  });

  it("logs participants by personId when resolved and by name otherwise, never twice, never with a sentiment", () => {
    const input = logInteractionInput(
      { title: "Christmas at home", type: "PARTY", occurredAt: "2026-12-24" },
      [
        { uri: "module://people/person/p_sam", label: "Sam Rivera" },
        { uri: null, label: "Jane Doe" },
        { uri: null, label: "jane doe" },
      ],
      { uri: "module://memory/memory/LIF/GTH/2026-12-24/001", label: "Christmas at home" },
    );
    expect(input).toEqual({
      title: "Christmas at home",
      type: "PARTY",
      occurredAt: "2026-12-24",
      participants: [{ personId: "p_sam" }, { name: "Jane Doe" }],
      refs: [{ uri: "module://memory/memory/LIF/GTH/2026-12-24/001", label: "Christmas at home" }],
    });
  });

  it("the back reference is people.update_interaction with the whole merged refs list", () => {
    const mine = { uri: "module://memory/memory/LIF/GTH/2026-12-24/001", label: "Christmas at home" };
    const other = { uri: "module://notes/note/n1", label: "Menu" };
    expect(backRefCall("module://people/event/e_8812", mine, [other, { ...mine, label: "old" }])).toMatchObject({
      tool: "people.update_interaction",
      input: { eventId: "e_8812", patch: { refs: [other, mine] } },
    });
    expect(backRefCall("not an event", mine)).toBeNull();
  });

  it("a note on a person still a name resolves first", () => {
    expect(noteCall({ uri: null, label: "Sam Rivera" }, "New partner.", "2026-12-24")).toMatchObject({
      tool: "people.add_note",
      input: { personId: null, occurredAt: "2026-12-24" },
      resolveFirst: { tool: "people.resolve_person", input: { name: "Sam Rivera" } },
    });
  });

  it("reads the people events in the shapes Fellowship emits", () => {
    expect(readPersonCreated({ personId: "p_sam", displayName: "Sam Rivera" })).toEqual({
      uri: "module://people/person/p_sam",
      name: "Sam Rivera",
    });
    expect(readInteractionLogged({ eventId: "e_1", personIds: ["p_sam", "p_jane", "p_sam"], occurredAt: "2026-12-24T00:00:00.000Z" })).toEqual({
      occasion: "module://people/event/e_1",
      occurredOn: "2026-12-24",
      people: ["module://people/person/p_jane", "module://people/person/p_sam"],
      title: null,
    });
    expect(
      readInteractionChanged({
        eventId: "e_1",
        change: "participants",
        occurredAt: "2026-12-24T00:00:00.000Z",
        title: "Christmas at home",
        participants: [{ personId: "p_sam", name: "Sam Rivera", sentiment: 2 }],
      }),
    ).toEqual({
      occasion: "module://people/event/e_1",
      change: "participants",
      occurredOn: "2026-12-24",
      title: "Christmas at home",
      participants: [{ uri: "module://people/person/p_sam", label: "Sam Rivera" }],
    });
    expect(readInteractionChanged({ eventId: "e_1", change: "removed", participants: [] })).toMatchObject({ change: "removed", participants: null });
    expect(readInteractionChanged({ eventId: "e_1", change: "exploded" })).toBeNull();
    expect(readInteractionLogged({})).toBeNull();
  });
});
