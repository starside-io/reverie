import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { LinkOccasionToolResult } from "../../../src/tools/write/link-occasion.js";
import { PEOPLE, testHost, type TestHost } from "../../test-host.js";
import { christmas, NOW, remember, versions } from "./helpers.js";

const OCCASION = "module://people/event/e_8812";

describe("memory.link_occasion", () => {
  let host: TestHost;

  beforeEach(async () => {
    host = await testHost({ now: NOW });
  });
  afterEach(async () => {
    await host.close();
  });

  const linkOccasion = (input: Record<string, unknown>) =>
    host.invoke<LinkOccasionToolResult>("memory.link_occasion", input);

  it("with the people module absent, records the occasion as given and leaves the attendees", async () => {
    const episode = await christmas(host, { attendees: ["Jane Doe", "Sam Rivera"] });
    const result = await linkOccasion({ call: episode.memory.call, occasion: OCCASION, label: "Christmas at home" });

    expect(result).toMatchObject({ changed: true, synced: false, added: [], removed: [] });
    expect(result.notice).toContain("did not answer");
    expect(result.memory.occasion).toEqual({ role: "occasion", uri: OCCASION, label: "Christmas at home", status: "unavailable" });
    expect(result.memory.attendees.map((ref) => [ref.label, ref.status])).toEqual([
      ["Jane Doe", "unresolved"],
      ["Sam Rivera", "unresolved"],
    ]);

    const rows = await versions(host, episode.memory.id);
    expect(rows.map((row) => row.operation)).toEqual(["create", "update"]);
    expect(rows[0]?.content?.refs.some((ref) => ref.role === "occasion")).toBe(false);

    const again = await linkOccasion({ call: episode.memory.call, occasion: OCCASION, label: "Christmas at home" });
    expect(again.changed).toBe(false);
    expect(await versions(host, episode.memory.id)).toHaveLength(2);
  });

  it("syncs attendees from the occasion when the refs port answers", async () => {
    host.primePeople([PEOPLE.jane, PEOPLE.john, PEOPLE.sam]);
    host.primeRef(OCCASION, "Christmas at home", {
      participants: [
        { uri: PEOPLE.jane.uri, label: "Jane Doe" },
        { id: PEOPLE.john.id, name: "John Doe" },
        PEOPLE.sam.uri,
      ],
    });
    const episode = await christmas(host, {
      attendees: ["jane doe", "Someone From Work", "module://people/person/p_gone"],
    });

    const result = await linkOccasion({ call: episode.memory.call, occasion: OCCASION });
    expect(result.synced).toBe(true);
    expect(result.notice).toBeNull();
    expect(result.resolvedNames).toEqual(["jane doe"]);
    expect(result.keptNames).toEqual(["Someone From Work"]);
    expect(result.removed).toEqual(["module://people/person/p_gone"]);
    expect(result.added.sort()).toEqual([PEOPLE.jane.uri, PEOPLE.john.uri, PEOPLE.sam.uri].sort());

    expect(result.memory.occasion).toMatchObject({ uri: OCCASION, label: "Christmas at home", status: "resolved" });
    const attendees = result.memory.attendees.map((ref) => ({ uri: ref.uri, label: ref.label }));
    expect(attendees).toEqual(
      expect.arrayContaining([
        { uri: PEOPLE.jane.uri, label: "Jane Doe" },
        { uri: PEOPLE.john.uri, label: "John Doe" },
        { uri: PEOPLE.sam.uri, label: "Sam Rivera" },
        { uri: null, label: "Someone From Work" },
      ]),
    );
    expect(attendees).toHaveLength(4);
  });

  it("answers without participants leave the attendees as they are", async () => {
    host.primeRef(OCCASION, "Christmas at home");
    const episode = await christmas(host, { attendees: ["Jane Doe"] });
    const result = await linkOccasion({ call: episode.memory.call, occasion: OCCASION, label: "Xmas" });
    expect(result.synced).toBe(false);
    expect(result.notice).toContain("no participants");
    expect(result.memory.occasion?.label).toBe("Christmas at home");
    expect(result.memory.attendees).toEqual([{ role: "attendee", uri: null, label: "Jane Doe", status: "unresolved" }]);
  });

  it("replaces an occasion recorded earlier, one occasion per memory", async () => {
    const episode = await christmas(host, { occasion: "Christmas party" });
    const result = await linkOccasion({ call: episode.memory.call, occasion: OCCASION });
    expect(result.replaced).toBe("Christmas party");
    expect(result.memory.occasion).toMatchObject({ uri: OCCASION, label: OCCASION });
    expect(await host.db.memoryRef.count({ where: { memoryId: episode.memory.id, role: "occasion" } })).toBe(1);
  });

  it("refuses a memory that is not an episode, and a URI that is not an occasion", async () => {
    const fact = await remember(host, { body: "Prefers oat milk in coffee." });
    await expect(linkOccasion({ call: fact.memory.call, occasion: OCCASION })).rejects.toMatchObject({ code: "refused" });
    const episode = await christmas(host);
    await expect(linkOccasion({ call: episode.memory.call, occasion: PEOPLE.jane.uri })).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("refuses while incognito is on", async () => {
    const episode = await christmas(host);
    host.setIncognito(true);
    await expect(linkOccasion({ call: episode.memory.call, occasion: OCCASION })).rejects.toMatchObject({ code: "refused" });
    expect(await host.db.memoryRef.count()).toBe(0);
  });
});
