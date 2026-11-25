import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";

import { tools as coreTools } from "@reverie/core";
import { startMiniHost } from "@reverie/mini-host";

/**
 * The milestone's own test (docs/SPEC.md section 23, M4): a second Claude
 * Code session opens knowing what the first learned.
 *
 * Session one is the real MCP server in its own process, started the way
 * Claude Code starts a plugin's server: working directory the project folder,
 * CLAUDE_CODE_SESSION_ID in its environment, spoken to over stdio. It
 * registers the folder as a project, promotes a procedure with the owner's
 * yes, pins it, and writes a session note. Then the SessionEnd hook runs as
 * its own process with Claude Code's hook JSON on stdin. Session two is a new
 * process in the same folder: the SessionStart hook, whose output must hold
 * the procedure and the project slot, byte for byte the same on a second run.
 * Every name and place is invented.
 */

const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(APP_ROOT, "src", "cli.ts");
/** tsx by absolute URL, and its tsconfig named, so a process started in another folder still maps @reverie/* to source. */
const TSX = pathToFileURL(join(APP_ROOT, "node_modules", "tsx", "dist", "loader.mjs")).href;
const TSCONFIG = join(APP_ROOT, "tsconfig.json");

const SESSION_ONE = "0b9e4c1a-6d2f-4a8b-9c3e-5f7a1b2c3d4e";
const SESSION_TWO = "8e7d6c5b-4a39-4281-b7f6-e5d4c3b2a190";
const PROCEDURE = "Keep the seed tray labels in pencil, never ink.";

type Content = { content?: Array<{ type: string; text?: string }>; isError?: boolean };

function payloadOf<T>(result: unknown): T {
  const content = result as Content;
  const text = (content.content ?? []).find((entry) => entry.type === "text")?.text ?? "";
  if (content.isError) throw new Error(text);
  return JSON.parse(text) as T;
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

function additionalContext(stdout: string): string {
  return (JSON.parse(stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput
    .additionalContext;
}

describe("M4: a second session opens knowing what the first learned", () => {
  it("carries a pinned procedure and the project slot from one session to the next", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reverie-m4-"));
    const project = join(dir, "maple-street-allotment");
    mkdirSync(project);
    const transcript = join(dir, "claude", "projects", `${SESSION_ONE}.jsonl`);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      REVERIE_DB_PATH: join(dir, "reverie.db"),
      REVERIE_HOST_DB_PATH: join(dir, "host.db"),
    };
    delete env["REVERIE_SESSION_ID"];

    // Session one: the MCP server Claude Code would start.
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", TSX, CLI, "mcp"],
      cwd: project,
      env: { ...(env as Record<string, string>), TSX_TSCONFIG_PATH: TSCONFIG, CLAUDE_CODE_SESSION_ID: SESSION_ONE },
      stderr: "pipe",
    });
    const client = new Client({ name: "session-one", version: "0.0.1" });
    await client.connect(transport);
    let call: string;
    try {
      payloadOf(
        await client.callTool({
          name: "memory_set_projects",
          arguments: { action: "create", slug: "maple-street", name: "Maple Street Allotment", folders: [project] },
        }),
      );
      const projects = payloadOf<{ current: { slug: string } | null }>(
        await client.callTool({ name: "memory_projects", arguments: {} }),
      );
      expect(JSON.stringify(projects)).toContain("maple-street");

      const promoted = payloadOf<{ memory: { call: string } }>(
        await client.callTool({
          name: "memory_promote_procedure",
          arguments: {
            body: PROCEDURE,
            title: "Seed tray labels",
            why: "Sam Rivera found ink runs when the trays are watered.",
            howToApply: "Whenever labelling a seed tray.",
            shelf: "CRF/HOW",
            occurredOn: "2026-11-20",
            said: PROCEDURE,
            confirmedByUser: true,
          },
        }),
      );
      call = promoted.memory.call;
      payloadOf(await client.callTool({ name: "memory_pin", arguments: { call, pinned: true } }));

      const note = payloadOf<{ note: { sessionId: string } }>(
        await client.callTool({
          name: "memory_session_note",
          arguments: { body: "Jane Doe prefers the north beds for the tomatoes this year." },
        }),
      );
      // The note is filed under Claude Code's session id, the one the hook will see.
      expect(note.note.sessionId).toBe(SESSION_ONE);
    } finally {
      await client.close();
    }

    // Session one ends: Claude Code runs the SessionEnd hook.
    const ended = await runHook(
      "session-end",
      { session_id: SESSION_ONE, transcript_path: transcript, cwd: project, hook_event_name: "SessionEnd", reason: "other" },
      project,
      env,
    );
    expect(ended).toEqual({ code: 0, stdout: "" });

    // Session two, in the same folder: the SessionStart hook.
    const startInput = { session_id: SESSION_TWO, cwd: project, hook_event_name: "SessionStart", source: "startup" };
    const first = await runHook("session-start", startInput, project, env);
    expect(first.code).toBe(0);
    const context = additionalContext(first.stdout);
    expect(context).toContain(call);
    expect(context).toContain(PROCEDURE);
    expect(context).toContain("## Current project");
    expect(context).toContain("Maple Street Allotment, shelf");

    const second = await runHook("session-start", startInput, project, env);
    expect(second.stdout).toBe(first.stdout);

    // What the SessionEnd hook left behind, and how it lines up with the note.
    const host = await startMiniHost({ env });
    try {
      expect(await coreTools.shared.readyForExtraction(host.ports)).toEqual([SESSION_ONE]);
      expect(await coreTools.shared.transcriptPointers(host.ports)).toEqual({ [SESSION_ONE]: transcript });

      const notes = await host.silo.sessionNote.findMany({ where: { sessionId: SESSION_ONE } });
      expect(notes.map((row) => row.body)).toEqual(["Jane Doe prefers the north beds for the tomatoes this year."]);

      // The extract job is not given the note today. It takes only the turns
      // or the file the caller passes as material, and no tool reads session
      // notes or the transcript pointer back, so an extractor in a later
      // session cannot reach either through the tools.
      const extract = (await host.api.invoke(
        "memory.draft_context",
        { job: "extract", material: { kind: "turns", turns: [{ role: "user", text: "Let us plan the beds." }] } },
        { session: { id: SESSION_ONE, folder: project } },
      )) as Record<string, unknown>;
      expect(JSON.stringify(extract)).not.toContain("north beds");
      expect(JSON.stringify(extract)).not.toContain(transcript);
    } finally {
      await host.close();
    }
  }, 60_000);
});
