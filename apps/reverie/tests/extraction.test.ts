import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";

/**
 * Extraction from a finished session, end to end, every piece in its own
 * process the way Claude Code runs them (docs/SPEC.md sections 13, 15, 18,
 * 19). Session one writes a session note over the real MCP server and has a
 * transcript on disk; the SessionEnd hook marks it ready with a pointer to
 * that transcript. Session two learns it is ready, gets its notes and turns
 * from memory_draft_context, proposes a draft quoting the transcript, and
 * finds the proposal in review at trust inferred (the quote is the
 * assistant's turn), the made up quote refused, and the session no longer
 * waiting. The transcript and every name in it are invented.
 */

const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(APP_ROOT, "src", "cli.ts");
const TSX = pathToFileURL(join(APP_ROOT, "node_modules", "tsx", "dist", "loader.mjs")).href;
const TSCONFIG = join(APP_ROOT, "tsconfig.json");

const SESSION_ONE = "3c1d9e2f-7a4b-4c5d-8e6f-0a1b2c3d4e5f";
const SESSION_TWO = "9f8e7d6c-5b4a-4392-a1b0-c9d8e7f6a5b4";

const NOTE = "Jane Doe asked to keep the greenhouse keys with John Doe from now on.";
const OWNER_TURN = "Sam Rivera can water the seedlings on weekends, he offered at the allotment meeting.";
const ASSISTANT_TURN = "Agreed: Sam Rivera waters the seedlings on weekends, and the rota stays on the shed door.";
/** Said in the transcript, quoted by nobody: it must reach no host table. */
const UNQUOTED = "The compost bins by the east fence were turned over by Jane Doe and John Doe together.";

type Content = { content?: Array<{ type: string; text?: string }>; isError?: boolean };

function payloadOf<T>(result: unknown): T {
  const content = result as Content;
  const text = (content.content ?? []).find((entry) => entry.type === "text")?.text ?? "";
  if (content.isError) throw new Error(text);
  return JSON.parse(text) as T;
}

function errorOf(result: unknown): string {
  const content = result as Content;
  expect(content.isError).toBe(true);
  return (content.content ?? []).find((entry) => entry.type === "text")?.text ?? "";
}

function runHook(
  event: string,
  stdin: Record<string, unknown>,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", TSX, CLI, "hook", event], {
      cwd,
      env: { ...env, TSX_TSCONFIG_PATH: TSCONFIG },
      stdio: ["pipe", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout }));
    child.stdin.end(JSON.stringify(stdin));
  });
}

async function mcpSession(cwd: string, env: NodeJS.ProcessEnv, sessionId: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", TSX, CLI, "mcp"],
    cwd,
    env: { ...(env as Record<string, string>), TSX_TSCONFIG_PATH: TSCONFIG, CLAUDE_CODE_SESSION_ID: sessionId },
    stderr: "pipe",
  });
  const client = new Client({ name: `session-${sessionId.slice(0, 4)}`, version: "0.0.1" });
  await client.connect(transport);
  return client;
}

/** An invented transcript in Claude Code's JSON Lines shape, with lines that are not turns among them. */
function writeTranscript(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const lines = [
    { type: "summary", summary: "Allotment rota", leafUuid: "l1" },
    { type: "user", message: { role: "user", content: OWNER_TURN }, timestamp: "2026-11-21T18:02:00.000Z" },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Weighing who waters on which day." },
          { type: "text", text: ASSISTANT_TURN },
          { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "/nowhere/rota.md" } },
        ],
      },
      timestamp: "2026-11-21T18:02:20.000Z",
    },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: "rota contents" }] } },
    { type: "user", message: { role: "user", content: UNQUOTED }, timestamp: "2026-11-21T18:05:00.000Z" },
  ];
  writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n{"type": broken line\n`);
}

function hostTables(path: string): Record<string, string> {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const dump = (table: string) => JSON.stringify(db.prepare(`SELECT * FROM "${table}"`).all());
    return { audit: dump("audit"), event: dump("event"), value: dump("value"), proposal: dump("proposal") };
  } finally {
    db.close();
  }
}

interface ReadyList {
  ready: Array<{ session: string; notes: number; transcript: boolean }>;
  transcripts: boolean;
}

interface SessionContext {
  material: { turns: Array<{ role: string; text: string }> };
  target: Record<string, unknown>;
  session: { id: string; notes: number; turns: number; transcript: string; notice: string };
  continuation: unknown;
  sourceTrust: string;
}

describe("extraction from a finished session", () => {
  it("hands a later session the notes and turns, binds the quotes to them, and lets the session go once proposed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reverie-extract-"));
    const project = join(dir, "maple-street-allotment");
    mkdirSync(project);
    const transcript = join(dir, "claude", "projects", "maple-street", `${SESSION_ONE}.jsonl`);
    writeTranscript(transcript);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      REVERIE_DB_PATH: join(dir, "reverie.db"),
      REVERIE_HOST_DB_PATH: join(dir, "host.db"),
    };
    delete env["REVERIE_SESSION_ID"];

    // Session one writes a note over MCP.
    const one = await mcpSession(project, env, SESSION_ONE);
    try {
      const note = payloadOf<{ note: { sessionId: string } }>(
        await one.callTool({ name: "memory_session_note", arguments: { body: NOTE } }),
      );
      expect(note.note.sessionId).toBe(SESSION_ONE);
    } finally {
      await one.close();
    }

    // Session one ends.
    const ended = await runHook(
      "session-end",
      { session_id: SESSION_ONE, transcript_path: transcript, cwd: project, hook_event_name: "SessionEnd", reason: "other" },
      project,
      env,
    );
    expect(ended).toEqual({ code: 0, stdout: "" });

    // Session two opens: the SessionStart line says a session waits.
    const start = await runHook(
      "session-start",
      { session_id: SESSION_TWO, cwd: project, hook_event_name: "SessionStart", source: "startup" },
      project,
      env,
    );
    expect(start.code).toBe(0);
    expect(start.stdout).toContain("1 finished session waits for extraction (/reverie:dream).");

    const two = await mcpSession(project, env, SESSION_TWO);
    try {
      // It learns which sessions are ready.
      const listed = payloadOf<ReadyList>(await two.callTool({ name: "memory_draft_context", arguments: { job: "extract" } }));
      expect(listed.transcripts).toBe(true);
      expect(listed.ready).toEqual([{ session: SESSION_ONE, notes: 1, transcript: true }]);

      // It gets that session's notes and turns.
      const context = payloadOf<SessionContext>(
        await two.callTool({ name: "memory_draft_context", arguments: { job: "extract", session: SESSION_ONE } }),
      );
      expect(context.material.turns.map((turn) => ({ role: turn.role, text: turn.text }))).toEqual([
        { role: "note", text: NOTE },
        { role: "user", text: OWNER_TURN },
        { role: "assistant", text: ASSISTANT_TURN },
        { role: "user", text: UNQUOTED },
      ]);
      expect(context.session).toMatchObject({ id: SESSION_ONE, notes: 1, turns: 3, transcript: "read" });
      expect(context.continuation).toBeNull();
      // The target names the session and the page, never the material.
      expect(context.target).toEqual({ job: "extract", session: SESSION_ONE, cursor: 0, sessionDate: "2026-11-21" });
      expect(JSON.stringify(context)).not.toContain("Weighing who waters");
      expect(JSON.stringify(context)).not.toContain("rota contents");
      expect(JSON.stringify(context)).not.toContain(transcript);

      // A target cannot carry its own material for a session.
      const mixed = errorOf(
        await two.callTool({
          name: "memory_propose_draft",
          arguments: {
            target: { ...context.target, material: { kind: "turns", turns: [{ role: "user", text: "Made up." }] } },
            draft: { candidates: [] },
          },
        }),
      );
      expect(mixed).toContain("invalid_input");

      // It proposes: one quote from the transcript, one that is not there.
      const proposed = payloadOf<{
        queued: Array<{ id: string; groupId: string | null }>;
        rejected: Array<{ index: number; code: string }>;
        extraction: { session: string; lastPage: boolean; cleared: boolean };
      }>(
        await two.callTool({
          name: "memory_propose_draft",
          arguments: {
            target: context.target,
            draft: {
              candidates: [
                {
                  kind: "fact",
                  title: "Weekend watering",
                  body: "Sam Rivera waters the seedlings at the Maple Street allotment on weekends.",
                  shelf: "LIF/HOM",
                  occurredOn: "2026-11-21",
                  tags: ["allotment"],
                  people: [{ name: "Sam Rivera" }],
                  occasion: null,
                  quote: "Sam Rivera waters the seedlings on weekends, and the rota stays on the shed door.",
                },
                {
                  kind: "fact",
                  title: "Greenhouse heater",
                  body: "John Doe fixed the greenhouse heater.",
                  shelf: "LIF/HOM",
                  occurredOn: "2026-11-21",
                  tags: [],
                  people: [{ name: "John Doe" }],
                  occasion: null,
                  quote: "John Doe fixed the greenhouse heater on Saturday.",
                },
              ],
            },
          },
        }),
      );
      expect(proposed.queued).toHaveLength(1);
      expect(proposed.rejected).toEqual([expect.objectContaining({ index: 1, code: "quote-not-in-material" })]);
      expect(proposed.extraction).toMatchObject({ session: SESSION_ONE, lastPage: true, cleared: true });
      expect(proposed.queued[0]?.groupId).toBe(`session:${SESSION_ONE}:2026-11-21`);

      // The proposal waits in review, drawn from the assistant's turn: inferred.
      const review = payloadOf<{
        proposals: Array<{ id: string; tool: string; payload: { draft: { sourceTrust: string; source: { uri: string; trust: string } } } }>;
      }>(await two.callTool({ name: "memory_review", arguments: {} }));
      expect(review.proposals).toHaveLength(1);
      const queued = review.proposals[0]!;
      expect(queued.id).toBe(proposed.queued[0]?.id);
      expect(queued.tool).toBe("memory.remember");
      expect(queued.payload.draft.sourceTrust).toBe("inferred");
      expect(queued.payload.draft.source).toMatchObject({ uri: `session:${SESSION_ONE}`, trust: "inferred" });

      // The session no longer waits, and its material can no longer be read or proposed again.
      const after = payloadOf<ReadyList>(await two.callTool({ name: "memory_draft_context", arguments: { job: "extract" } }));
      expect(after.ready).toEqual([]);
      expect(errorOf(await two.callTool({ name: "memory_draft_context", arguments: { job: "extract", session: SESSION_ONE } }))).toContain(
        "not_found",
      );
      expect(
        errorOf(
          await two.callTool({ name: "memory_propose_draft", arguments: { target: context.target, draft: { candidates: [] } } }),
        ),
      ).toContain("conflict");
    } finally {
      await two.close();
    }

    // No transcript text in host.db but the one quote the owner will review,
    // and no pointer left behind.
    const tables = hostTables(join(dir, "host.db"));
    for (const table of ["audit", "event", "value"] as const) {
      for (const text of [NOTE, OWNER_TURN, ASSISTANT_TURN, UNQUOTED, "Sam Rivera waters the seedlings on weekends"]) {
        expect(tables[table], `${table} holds transcript text`).not.toContain(text);
      }
    }
    expect(tables.proposal).not.toContain(UNQUOTED);
    expect(tables.proposal).not.toContain(OWNER_TURN);
    expect(tables.proposal).not.toContain(NOTE);
    expect(tables.value).not.toContain(transcript);
    expect(tables.value).not.toContain(SESSION_ONE);
    expect(existsSync(transcript)).toBe(true);
  }, 120_000);
});
