import { mkdtempSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  createTranscriptsConnector,
  readTranscriptPage,
  turnFromLine,
  type TranscriptUnavailable,
} from "../src/index.js";

/**
 * The transcript fixture is invented (Jane Doe, John Doe, Sam Rivera), in the
 * shape a Claude Code transcript has: conversation lines among lines that
 * are not. Every marker ending in SHOULD-NOT-APPEAR is something a turn must
 * never carry.
 */

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "session.jsonl");
const page = (offset = 0, maxTurns = 100, maxChars = 100_000) => ({ offset, maxTurns, maxChars });

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "reverie-transcripts-"));
}

describe("a transcript read as turns", () => {
  it("keeps what the owner typed and what the assistant wrote, and nothing else", async () => {
    const read = await readTranscriptPage(FIXTURE, page());
    expect(read.turns.map(({ index, role, text }) => ({ index, role, text }))).toEqual([
      { index: 0, role: "user", text: "Jane Doe and I agreed the north beds get the tomatoes on the Maple Street allotment." },
      { index: 1, role: "assistant", text: "Noted: the north beds are for tomatoes, and Sam Rivera keeps the seed trays." },
      { index: 2, role: "user", text: "John Doe sent this photo of the shed roof." },
      { index: 3, role: "assistant", text: "The shed roof needs two new felt sheets before the frost." },
    ]);
    expect(read.turns[0]?.timestamp).toBe("2026-11-20T09:01:00.000Z");
    expect(read.turns[3]?.timestamp).toBeUndefined();
    expect(JSON.stringify(read)).not.toContain("SHOULD-NOT-APPEAR");
    expect(read.skipped.malformed).toBe(1);
    expect(read.skipped.other).toBe(7);
    expect(read.next).toBeNull();
    expect(read.cut).toBe(false);
  });

  it("pages by turn, and a page is never empty while turns remain", async () => {
    const first = await readTranscriptPage(FIXTURE, page(0, 3));
    expect(first.turns.map((turn) => turn.index)).toEqual([0, 1, 2]);
    expect(first.next).toBe(3);
    const second = await readTranscriptPage(FIXTURE, page(3, 3));
    expect(second.turns.map((turn) => turn.index)).toEqual([3]);
    expect(second.next).toBeNull();

    // A character budget smaller than one turn still hands that turn over.
    const tight = await readTranscriptPage(FIXTURE, page(0, 100, 10));
    expect(tight.turns).toHaveLength(1);
    expect(tight.next).toBe(1);

    const past = await readTranscriptPage(FIXTURE, page(50));
    expect(past).toMatchObject({ turns: [], next: null });
  });

  it("tolerates malformed lines, caps a turn, skips an oversized line without holding it, and stops at the file cap", async () => {
    const dir = scratch();
    const file = join(dir, "long.jsonl");
    const huge = JSON.stringify({ type: "user", message: { role: "user", content: "x".repeat(50_000) } });
    writeFileSync(
      file,
      [
        "not json at all",
        "{\"type\":",
        JSON.stringify({ type: "user", message: { role: "user", content: `Sam Rivera ${"y".repeat(500)}` } }),
        huge,
        JSON.stringify({ type: "assistant", message: { role: "assistant", content: "Binary \u0000 inside" } }),
        JSON.stringify({ type: "assistant", message: { role: "user", content: "role does not match the line" } }),
        JSON.stringify({ type: "assistant", message: { role: "assistant", content: "Last words from the assistant." } }),
      ].join("\n"),
    );
    const read = await readTranscriptPage(file, page(), { maxFileBytes: 10_000_000, maxLineBytes: 20_000, maxTurnChars: 100 });
    expect(read.skipped).toEqual({ malformed: 2, oversized: 1, other: 2 });
    expect(read.turns).toHaveLength(2);
    expect(read.turns[0]?.text).toHaveLength(100);
    expect(read.turns[0]?.truncated).toBe(true);
    expect(read.turns[1]?.text).toBe("Last words from the assistant.");

    const cut = await readTranscriptPage(file, page(), { maxFileBytes: 200, maxLineBytes: 20_000, maxTurnChars: 100 });
    expect(cut.cut).toBe(true);
  });

  it("reads a line as a turn or says why not", () => {
    expect(turnFromLine("{")).toBe("malformed");
    expect(turnFromLine("[]")).toBe("other");
    expect(turnFromLine(JSON.stringify({ type: "progress" }))).toBe("other");
    expect(turnFromLine(JSON.stringify({ type: "user", message: { role: "user", content: "  " } }))).toBe("other");
    expect(turnFromLine(JSON.stringify({ type: "user", message: { role: "user", content: "Jane Doe waved." }, timestamp: "nope" }))).toEqual({
      role: "user",
      text: "Jane Doe waved.",
    });
  });
});

describe("what a pointer may name", () => {
  it("refuses anything that is not an absolute path to a regular .jsonl file", async () => {
    const dir = scratch();
    const secret = join(dir, "notes.txt");
    writeFileSync(secret, "Jane Doe's private notes");
    const linked = join(dir, "linked.jsonl");
    symlinkSync(FIXTURE, linked);
    const folder = join(dir, "folder.jsonl");
    mkdirSync(folder);

    const refusal = (path: string) =>
      readTranscriptPage(path, page()).then(
        () => "read",
        (error: TranscriptUnavailable) => error.code,
      );
    expect(await refusal("relative/session.jsonl")).toBe("not_absolute");
    expect(await refusal(secret)).toBe("not_jsonl");
    expect(await refusal(linked)).toBe("symlink");
    expect(await refusal(folder)).toBe("not_a_file");
    expect(await refusal(join(dir, "gone.jsonl"))).toBe("missing");
  });
});

describe("the connector", () => {
  it("reads only the path stored for the session the cursor names", async () => {
    const asked: string[] = [];
    const connector = createTranscriptsConnector({
      pointerFor: (session) => {
        asked.push(session);
        return session === "session-jane" ? FIXTURE : null;
      },
    });
    const first = await connector.pull(JSON.stringify({ session: "session-jane", maxTurns: 2 }));
    expect(first.items.map((item) => item.id)).toEqual(["turn:0", "turn:1"]);
    expect(first.items[0]?.payload).toEqual({
      role: "user",
      text: "Jane Doe and I agreed the north beds get the tomatoes on the Maple Street allotment.",
      timestamp: "2026-11-20T09:01:00.000Z",
    });
    expect(first.cursor).not.toBeNull();
    const second = await connector.pull(first.cursor);
    expect(second.items.map((item) => item.id)).toEqual(["turn:2", "turn:3"]);
    expect(second.cursor).toBeNull();

    // A cursor that carries a path still reads only the stored pointer.
    const sneaky = await connector.pull(JSON.stringify({ session: "session-jane", path: "/etc/hosts", maxTurns: 1 }));
    expect(sneaky.items).toHaveLength(1);

    const codeOf = (cursor: string | null) =>
      connector.pull(cursor).then(
        () => "read",
        (error: TranscriptUnavailable) => error.code,
      );
    expect(await codeOf(JSON.stringify({ session: "session-john" }))).toBe("no_pointer");
    expect(await codeOf("not json")).toBe("bad_cursor");
    expect(await codeOf(null)).toBe("bad_cursor");
    expect(await codeOf(JSON.stringify({ path: FIXTURE }))).toBe("bad_cursor");
    expect(asked).toEqual(["session-jane", "session-jane", "session-jane", "session-john"]);
  });
});
