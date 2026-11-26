import { afterEach, describe, expect, it } from "vitest";

import type { ConnectorsPort } from "../../../src/ports.js";
import { EXTRACT_PAGE_MAX_CHARS, EXTRACT_PAGE_MAX_TURNS } from "../../../src/tools/shared/extraction.js";
import { endSession, readyForExtraction, transcriptPointers } from "../../../src/tools/shared/host-values.js";
import { auditStrings, testHost, type TestHost } from "../../test-host.js";

/**
 * Extraction from a finished session, in core, against a transcripts double
 * behind the connectors port. docs/SPEC.md sections 7 (incognito), 13, 15,
 * 18 and 19. Every turn and name is invented.
 */

const NOW = new Date("2026-11-26T10:00:00.000Z");
const SESSION = "session-ended-1";
const NOTE = "Jane Doe wants the greenhouse keys kept with John Doe.";

/** Invented turns, two per page unless the cursor asks for fewer. */
const TURNS = [
  { role: "user", text: "Sam Rivera offered to water the seedlings on weekends.", timestamp: "2026-11-24T18:00:00.000Z" },
  { role: "assistant", text: "Noted: Sam Rivera waters the seedlings on weekends." },
  { role: "user", text: "John Doe will repaint the shed door in green." },
  { role: "assistant", text: "Understood: the shed door gets a coat of green from John Doe." },
  { role: "user", text: "Jane Doe found the spare hose in the loft." },
];

interface Pulled {
  connector: string;
  cursor: Record<string, unknown>;
}

function transcriptsDouble(options: { perPage?: number; refuse?: string } = {}): { port: ConnectorsPort; pulls: Pulled[] } {
  const pulls: Pulled[] = [];
  const perPage = options.perPage ?? 2;
  return {
    pulls,
    port: {
      pull: async (connector, raw) => {
        const cursor = JSON.parse(raw ?? "{}") as { session: string; offset: number; maxTurns: number };
        pulls.push({ connector, cursor });
        if (options.refuse) throw Object.assign(new Error("refused by the double"), { code: options.refuse });
        if (cursor.session !== SESSION) throw Object.assign(new Error("no pointer"), { code: "no_pointer" });
        const take = Math.min(perPage, cursor.maxTurns);
        const slice = TURNS.slice(cursor.offset, cursor.offset + take);
        const next = cursor.offset + slice.length;
        return {
          items: slice.map((turn, index) => ({ id: `turn:${cursor.offset + index}`, payload: turn })),
          cursor: next < TURNS.length ? JSON.stringify({ ...cursor, offset: next }) : null,
        };
      },
    },
  };
}

interface ReadyList {
  ready: Array<{ session: string; notes: number; transcript: boolean }>;
  transcripts: boolean;
  incognito: boolean;
}

interface SessionContext {
  material: { turns: Array<{ role: string; text: string }> };
  target: Record<string, unknown>;
  session: { notes: number; turns: number; transcript: string; transcriptReason: string | null; notice: string };
  continuation: Record<string, unknown> | null;
  counts: Record<string, number>;
  prompt: string;
}

interface Proposed {
  queued: Array<{ id: string; groupId: string | null }>;
  rejected: Array<{ index: number; code: string }>;
  extraction?: { session: string; cursor: number; lastPage: boolean; cleared: boolean; continuation: Record<string, unknown> | null };
}

function candidate(quote: string, overrides: Record<string, unknown> = {}) {
  return {
    kind: "fact",
    title: "Allotment note",
    body: quote,
    shelf: "LIF/HOM",
    occurredOn: "2026-11-24",
    tags: [],
    people: [],
    occasion: null,
    quote,
    ...overrides,
  };
}

let host: TestHost;

async function setup(connectors?: ConnectorsPort, ended = true): Promise<void> {
  host = await testHost({ now: NOW, session: { id: "session-now" }, ...(connectors ? { connectors } : {}) });
  await host.db.sessionNote.create({
    data: { sessionId: SESSION, body: NOTE, createdAt: new Date("2026-11-24T17:00:00.000Z"), expiresAt: new Date("2026-11-28T00:00:00.000Z") },
  });
  if (ended) await endSession(host.ports, SESSION, "/nowhere/reverie-test/session-ended-1.jsonl");
}

afterEach(async () => {
  await host?.close();
});

const list = () => host.invoke<ReadyList>("memory.draft_context", { job: "extract" });
const context = (input: Record<string, unknown>) =>
  host.invoke<SessionContext>("memory.draft_context", { job: "extract", session: SESSION, ...input });
const propose = (target: unknown, candidates: unknown[]) =>
  host.invoke<Proposed>("memory.propose_draft", { target, draft: { candidates } });

describe("the sessions waiting for extraction", () => {
  it("are listed by extract with no material and no session, with note counts and whether a transcript is there", async () => {
    await setup(transcriptsDouble().port);
    await endSession(host.ports, "session-no-pointer", null);
    expect(await list()).toMatchObject({
      ready: [
        { session: SESSION, notes: 1, transcript: true },
        { session: "session-no-pointer", notes: 0, transcript: false },
      ],
      transcripts: true,
      incognito: false,
    });
  });

  it("refuse a session that is not waiting, and a cursor with no session", async () => {
    await setup(transcriptsDouble().port, false);
    await expect(context({})).rejects.toMatchObject({ code: "not_found" });
    await expect(host.invoke("memory.draft_context", { job: "extract", cursor: 2 })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      host.invoke("memory.draft_context", {
        job: "extract",
        session: SESSION,
        material: { kind: "turns", turns: [{ role: "user", text: "Made up." }] },
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});

describe("one finished session's material", () => {
  it("is its notes alone without a connector, and says so", async () => {
    await setup();
    const page = await context({});
    expect(page.material.turns).toEqual([{ role: "note", text: NOTE, at: "2026-11-24T17:00:00.000Z" }]);
    expect(page.session).toMatchObject({ notes: 1, turns: 0, transcript: "no_connector" });
    expect(page.session.notice).toContain("notes alone");
    expect(page.continuation).toBeNull();
    expect(page.target).toEqual({ job: "extract", session: SESSION, cursor: 0, sessionDate: "2026-11-24" });

    // A quote from a note is the assistant's words: inferred, cited as a session note.
    const proposed = await propose(page.target, [candidate(NOTE, { people: [{ name: "Jane Doe" }, { name: "John Doe" }] })]);
    expect(proposed.queued).toHaveLength(1);
    expect(proposed.extraction).toMatchObject({ lastPage: true, cleared: true });
    const draft = (host.proposals[0]?.payload as { draft: { sourceTrust: string; source: { label: string; uri: string } } }).draft;
    expect(draft.sourceTrust).toBe("inferred");
    expect(draft.source).toMatchObject({ label: "session note of 2026-11-24", uri: `session:${SESSION}` });
    expect(await readyForExtraction(host.ports)).toEqual([]);
  });

  it("says why when the transcript could not be read, by code only", async () => {
    await setup(transcriptsDouble({ refuse: "missing" }).port);
    const page = await context({});
    expect(page.session).toMatchObject({ transcript: "unavailable", transcriptReason: "missing", turns: 0, notes: 1 });
    expect(page.session.notice).toContain("(missing)");
  });

  it("comes in pages: notes and the first turns, then a continuation, each page bound to its own quotes", async () => {
    const double = transcriptsDouble();
    await setup(double.port);
    const first = await context({});
    expect(first.material.turns.map((turn) => turn.role)).toEqual(["note", "user", "assistant"]);
    expect(first.session).toMatchObject({ notes: 1, turns: 2, transcript: "read" });
    expect(first.continuation).toEqual({ job: "extract", session: SESSION, cursor: 2, sessionDate: "2026-11-24" });
    expect(first.counts).toMatchObject({ notes: 1, transcriptTurns: 2, pageMaxCharacters: EXTRACT_PAGE_MAX_CHARS });
    // Core names the session and the page, never a path.
    expect(double.pulls[0]).toEqual({
      connector: "transcripts",
      cursor: { session: SESSION, offset: 0, maxTurns: EXTRACT_PAGE_MAX_TURNS, maxChars: EXTRACT_PAGE_MAX_CHARS },
    });

    // Proposing a page that is not the last keeps the session waiting.
    const one = await propose(first.target, [candidate("Noted: Sam Rivera waters the seedlings on weekends.", { people: [{ name: "Sam Rivera" }] })]);
    expect(one.queued).toHaveLength(1);
    expect(one.extraction).toMatchObject({ cursor: 0, lastPage: false, cleared: false, continuation: first.continuation });
    expect(await readyForExtraction(host.ports)).toEqual([SESSION]);

    const second = await context(first.continuation as Record<string, unknown>);
    expect(second.material.turns.map((turn) => turn.text)).toEqual([TURNS[2]?.text, TURNS[3]?.text]);
    expect(second.session.notes).toBe(0);

    // A quote from page one is not on page two.
    const wrongPage = await propose(second.target, [candidate(NOTE)]);
    expect(wrongPage.rejected).toEqual([expect.objectContaining({ code: "quote-not-in-material" })]);

    const third = await context(second.continuation as Record<string, unknown>);
    expect(third.continuation).toBeNull();
    // Every candidate of the last page refused: the session waits, to be drafted again.
    const refused = await propose(third.target, [candidate("Nobody said this.")]);
    expect(refused.extraction).toMatchObject({ lastPage: true, cleared: false });
    expect(await readyForExtraction(host.ports)).toEqual([SESSION]);

    const last = await propose(third.target, [candidate("Jane Doe found the spare hose in the loft.", { people: [{ name: "Jane Doe" }] })]);
    expect(last.queued).toHaveLength(1);
    expect(last.extraction).toMatchObject({ lastPage: true, cleared: true });
    expect(await readyForExtraction(host.ports)).toEqual([]);
    expect(await transcriptPointers(host.ports)).toEqual({});

    // Once let go, the session can be neither read nor proposed again.
    await expect(context({})).rejects.toMatchObject({ code: "not_found" });
    await expect(propose(third.target, [])).rejects.toMatchObject({ code: "conflict" });

    // The audit log holds no turn and no note.
    const logged = auditStrings(host).join("\n");
    for (const turn of TURNS) expect(logged).not.toContain(turn.text);
    expect(logged).not.toContain(NOTE);
  });

  it("lets a session go when its last page is proposed with nothing worth keeping", async () => {
    await setup(transcriptsDouble({ perPage: 10 }).port);
    const page = await context({});
    expect(page.continuation).toBeNull();
    const proposed = await propose(page.target, []);
    expect(proposed).toMatchObject({ queued: [], rejected: [], extraction: { cleared: true } });
    expect(await readyForExtraction(host.ports)).toEqual([]);
  });

  it("is not read while incognito is on, and nothing is proposed", async () => {
    const double = transcriptsDouble();
    await setup(double.port);
    host.setIncognito(true);
    expect(await list()).toMatchObject({ incognito: true, ready: [{ session: SESSION }] });
    await expect(context({})).rejects.toMatchObject({ code: "refused", detail: { incognito: true } });
    expect(double.pulls).toEqual([]);
    await expect(propose({ job: "extract", session: SESSION, cursor: 0 }, [])).rejects.toMatchObject({ code: "refused" });
    expect(await readyForExtraction(host.ports)).toEqual([SESSION]);
  });
});
