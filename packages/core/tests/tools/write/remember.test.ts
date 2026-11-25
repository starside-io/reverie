import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { QUOTE_MAX_LENGTH } from "../../../src/schemas/source.js";
import type { RememberResult } from "../../../src/tools/write/remember.js";
import { deriveTitle } from "../../../src/tools/write/remember.js";
import { auditStrings, PEOPLE, testHost, type TestHost } from "../../test-host.js";
import { ftsHits } from "../../domain/library.js";

const NOW = new Date("2026-12-27T10:00:00.000Z");

describe("memory.remember", () => {
  let host: TestHost;

  beforeEach(async () => {
    host = await testHost({ now: NOW, session: { id: "session-1" } });
  });
  afterEach(async () => {
    await host.close();
  });

  const remember = (input: Record<string, unknown>) =>
    host.invoke<RememberResult>("memory.remember", { kind: "fact", ...input });

  it("writes at once with trust stated, on the shelf given", async () => {
    const result = await remember({
      kind: "episode",
      shelf: "LIF/GTH",
      occurredOn: "2026-12-24",
      title: "Christmas at home",
      body: "Hosted Christmas. The oven died mid afternoon, so we ordered pizza.",
    });

    expect(result.memory).toMatchObject({
      call: "LIF/GTH/2026-12-24/001",
      trust: "stated",
      state: "active",
      kind: "episode",
      title: "Christmas at home",
      scope: "global",
    });
    expect(result.landedOnReturns).toBe(false);
    expect(result.notice).toBeNull();
    expect(await host.db.memory.count()).toBe(1);
    expect(await ftsHits(host.db, "pizza")).toHaveLength(1);
  });

  it("lands on Returns with no shelf, dated today, and says so", async () => {
    const result = await remember({ body: "Prefers oat milk in coffee." });

    expect(result.memory.call).toBe("DSK/RET/2026-12-27/001");
    expect(result.landedOnReturns).toBe(true);
    expect(result.notice).toContain("DSK/RET");
    expect(result.memory.title).toBe("Prefers oat milk in coffee");
  });

  it("cites the owner's statement as a conversation source, quote capped at 500", async () => {
    const said = "x".repeat(QUOTE_MAX_LENGTH + 40);
    const result = await remember({ body: "Keeps a long list of words.", said });

    expect(result.memory.sources).toHaveLength(1);
    const [source] = result.memory.sources;
    expect(source).toMatchObject({
      kind: "conversation",
      label: "session of 2026-12-27",
      uri: "session:session-1",
      trust: "stated",
    });
    expect(source?.quote).toHaveLength(QUOTE_MAX_LENGTH);

    const fromBody = await remember({ body: "Walks to work on Fridays." });
    expect(fromBody.memory.sources[0]?.quote).toBe("Walks to work on Fridays.");
  });

  it("attaches given tags and inline #tags as one normalised vocabulary", async () => {
    const result = await remember({
      shelf: "WRK/NST",
      body: "Pricing stays flat for the first year. #NightStash #pricing",
      tags: ["#Work", "nightstash"],
    });
    expect(result.memory.tags).toEqual(["nightstash", "pricing", "work"]);
    expect(await host.db.tag.count({ where: { slug: "nightstash" } })).toBe(1);
  });

  it("keeps names as unresolved labels and URIs as references", async () => {
    host.primePeople([PEOPLE.jane]);
    const result = await remember({
      kind: "episode",
      shelf: "LIF/GTH",
      occurredOn: "2026-12-24",
      body: "Christmas dinner at home.",
      attendees: [PEOPLE.jane.uri, "Sam Rivera", PEOPLE.john.uri],
      occasion: "module://people/event/e_8812",
    });

    expect(result.unresolved).toEqual(["Sam Rivera"]);
    expect(result.memory.attendees).toEqual([
      { role: "attendee", uri: PEOPLE.jane.uri, label: "Jane Doe", status: "resolved" },
      { role: "attendee", uri: null, label: "Sam Rivera", status: "unresolved" },
      { role: "attendee", uri: PEOPLE.john.uri, label: PEOPLE.john.uri, status: "unavailable" },
    ]);
    expect(result.memory.occasion).toMatchObject({ uri: "module://people/event/e_8812", status: "unavailable" });

    const rows = await host.db.memoryRef.findMany({ where: { label: "Sam Rivera" } });
    expect(rows).toEqual([expect.objectContaining({ uri: null, resolved: false })]);
  });

  it("runs discipline: a secret, a relative date and an unasked sensitive category are refused", async () => {
    await expect(remember({ body: "The wifi password: hunter22 for the cabin." })).rejects.toMatchObject({
      code: "refused",
      detail: { findings: expect.arrayContaining([expect.objectContaining({ check: "secret" })]) },
    });
    await expect(remember({ body: "Went climbing yesterday with Jane Doe." })).rejects.toMatchObject({
      code: "refused",
      detail: { findings: expect.arrayContaining([expect.objectContaining({ check: "relativeDate" })]) },
    });
    await expect(remember({ body: "Sees a therapist on Tuesdays." })).rejects.toMatchObject({
      code: "refused",
      detail: { findings: expect.arrayContaining([expect.objectContaining({ check: "sensitive", label: "health" })]) },
    });
    expect(await host.db.memory.count()).toBe(0);

    const asked = await remember({ body: "Sees a therapist on Tuesdays.", explicitAsk: true });
    expect(asked.memory.trust).toBe("stated");
  });

  it("scans the quote for secrets too, but lets the owner's own words say yesterday", async () => {
    await expect(
      remember({ body: "Has a cabin wifi network.", said: "the wifi password: hunter22" }),
    ).rejects.toMatchObject({ code: "refused" });

    const ok = await remember({
      body: "Went climbing on 2026-12-26 with Jane Doe.",
      said: "I went climbing yesterday with Jane",
    });
    expect(ok.memory.sources[0]?.quote).toBe("I went climbing yesterday with Jane");
  });

  it("refuses a procedure: that is promote_procedure's", async () => {
    await expect(remember({ kind: "procedure", body: "Always run the tests before a commit." })).rejects.toMatchObject(
      { code: "refused" },
    );
    expect(await host.db.memory.count()).toBe(0);
  });

  it("runs the duplicate guard and names the memory it already holds", async () => {
    const first = await remember({ body: "Prefers oat milk in coffee." });
    await expect(remember({ body: "prefers oat milk in coffee" })).rejects.toMatchObject({
      code: "conflict",
      detail: { call: first.memory.call, match: "exact" },
    });
    expect(await host.db.memory.count()).toBe(1);
  });

  it("fills scopeRef from the session, and resolves the project from a registered folder", async () => {
    await host.db.project.create({ data: { slug: "nightstash", name: "NightStash" } });
    host.localPaths.push({ project: "nightstash", path: "/work/nightstash" });
    host.session = { id: "session-1", folder: "/work/nightstash/packages/app" };

    const project = await remember({ body: "Deploys go out on Thursdays.", scope: "project" });
    expect(project.memory).toMatchObject({ scope: "project", scopeRef: "nightstash" });

    const session = await remember({ body: "Working on the billing page.", scope: "session" });
    expect(session.memory).toMatchObject({ scope: "session", scopeRef: "session-1" });

    host.session = { id: "session-2", folder: "/elsewhere" };
    await expect(remember({ body: "Something only here.", scope: "project" })).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("refuses while incognito is on, writes nothing, emits nothing", async () => {
    host.setIncognito(true);
    await expect(remember({ body: "Prefers oat milk in coffee." })).rejects.toMatchObject({
      code: "refused",
      detail: { incognito: true },
    });
    expect(await host.db.memory.count()).toBe(0);
    expect(host.events).toEqual([]);
    expect(host.audit.at(-1)).toMatchObject({ tool: "memory.remember", detail: { refused: "incognito" } });
  });

  it("emits memory.memory.written once, after the commit, with no text", async () => {
    let rowsWhenEmitted = -1;
    const record = host.ports.bus.emit;
    host.ports.bus.emit = async (name, payload) => {
      rowsWhenEmitted = await host.db.memory.count();
      await record(name, payload);
    };

    const result = await remember({ body: "Prefers oat milk in coffee." });

    expect(rowsWhenEmitted).toBe(1);
    expect(host.events).toEqual([
      {
        name: "memory.memory.written",
        payload: {
          memoryId: result.memory.id,
          call: result.memory.call,
          door: "direct",
          operation: "create",
          kind: "fact",
          trust: "stated",
        },
      },
    ]);

    await remember({ body: "prefers oat milk in coffee" }).catch(() => undefined);
    expect(host.events).toHaveLength(1);
  });

  it("audits with ids and counts, never the body or the quote", async () => {
    const result = await remember({ body: "Prefers oat milk in coffee.", said: "oat milk, always" });
    const line = host.audit.at(-1);
    expect(line).toMatchObject({
      tool: "memory.remember",
      kind: "write",
      ids: { memoryIds: [result.memory.id], calls: [result.memory.call] },
      detail: { landedOnReturns: true, unresolvedCount: 0 },
    });
    const strings = auditStrings(host);
    expect(strings.some((text) => text.includes("oat milk"))).toBe(false);
  });
});

describe("deriveTitle", () => {
  it("takes the first sentence, without its full stop", () => {
    expect(deriveTitle("Prefers oat milk. Also likes tea.")).toBe("Prefers oat milk");
  });

  it("cuts a long first sentence at a word", () => {
    const title = deriveTitle(`${"word ".repeat(40)}end.`);
    expect(title.length).toBeLessThanOrEqual(80);
    expect(title.endsWith("word")).toBe(true);
  });
});
