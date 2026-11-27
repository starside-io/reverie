import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { tools as coreTools } from "@reverie/core";
import { startMiniHost, type MiniHost } from "@reverie/mini-host";

import { INCOGNITO_LINE, PRE_COMPACT_TEXT, SESSION_START_LEAD, runHook, type HookIo } from "../src/hook.js";

/**
 * The three plugin hooks, on throwaway silos. Most cases run runHook in this
 * process; one runs the CLI as a real process with the hook JSON on stdin, as
 * Claude Code does. Every name and place is invented.
 */

const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = join(APP_ROOT, "..", "..");

interface Captured extends HookIo {
  stdout: string;
  dir: string;
  project: string;
}

function throwaway(): Captured {
  const dir = mkdtempSync(join(tmpdir(), "reverie-hook-"));
  const project = join(dir, "elmwood-garden");
  mkdirSync(project);
  const io: Captured = {
    dir,
    project,
    stdout: "",
    env: {
      ...process.env,
      REVERIE_DB_PATH: join(dir, "reverie.db"),
      REVERIE_HOST_DB_PATH: join(dir, "host.db"),
    },
    cwd: project,
    out: (text) => {
      io.stdout += text;
    },
  };
  return io;
}

async function withHost<T>(io: Captured, run: (host: MiniHost) => Promise<T>): Promise<T> {
  const host = await startMiniHost({ env: io.env });
  try {
    return await run(host);
  } finally {
    await host.close();
  }
}

function input(event: string, io: Captured, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: "3f6c2a1e-0b7d-4e5f-9a8b-1c2d3e4f5a6b",
    transcript_path: join(io.dir, "transcripts", "3f6c2a1e.jsonl"),
    cwd: io.project,
    hook_event_name: event,
    ...extra,
  });
}

async function hook(event: string, stdin: string, io: Captured): Promise<{ code: number; stdout: string }> {
  io.stdout = "";
  const code = await runHook(event, stdin, io);
  return { code, stdout: io.stdout };
}

function contextOf(stdout: string): string {
  const parsed = JSON.parse(stdout) as {
    hookSpecificOutput: { hookEventName: string; additionalContext: string };
  };
  expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
  return parsed.hookSpecificOutput.additionalContext;
}

/** A library with a project for the folder, a pinned procedure and a fact on its shelf. */
async function seed(io: Captured): Promise<{ procedure: string; fact: string }> {
  return withHost(io, async (host) => {
    await host.api.invoke("memory.set_projects", {
      action: "create",
      slug: "elmwood-garden",
      name: "Elmwood Garden",
      folders: [io.project],
    });
    const procedure = (await host.api.invoke("memory.promote_procedure", {
      body: "Water the raised beds before nine in the morning.",
      title: "Morning watering",
      why: "Jane Doe found the afternoon sun scorches wet leaves.",
      howToApply: "Schedule any watering task before nine.",
      shelf: "CRF/HOW",
      occurredOn: "2026-11-02",
      confirmedByUser: true,
    })) as { memory: { call: string } };
    await host.api.invoke("memory.pin", { call: procedure.memory.call, pinned: true });
    const fact = (await host.api.invoke(
      "memory.remember",
      {
        kind: "fact",
        title: "Compost bin by the shed",
        body: "The compost bin sits behind the shed at Elmwood Garden.",
        scope: "project",
        occurredOn: "2026-11-03",
      },
      { session: { folder: io.project } },
    )) as { memory: { call: string } };
    return { procedure: procedure.memory.call, fact: fact.memory.call };
  });
}

describe("reverie hook, with no library yet", () => {
  it("says nothing for any event and creates no file", async () => {
    const io = throwaway();
    for (const [event, name] of [
      ["session-start", "SessionStart"],
      ["pre-compact", "PreCompact"],
      ["session-end", "SessionEnd"],
    ] as const) {
      expect(await hook(event, input(name, io), io)).toEqual({ code: 0, stdout: "" });
    }
    expect(readdirSync(io.dir).sort()).toEqual(["elmwood-garden"]);
  });
});

describe("reverie hook session-start", () => {
  it("says nothing for an empty library", async () => {
    const io = throwaway();
    await withHost(io, async () => undefined);
    expect(await hook("session-start", input("SessionStart", io), io)).toEqual({ code: 0, stdout: "" });
  });

  it("adds the core block for this folder's project, byte for byte what memory_core returns", async () => {
    const io = throwaway();
    const { procedure, fact } = await seed(io);

    const first = await hook("session-start", input("SessionStart", io, { source: "startup" }), io);
    expect(first.code).toBe(0);
    const context = contextOf(first.stdout);

    const core = await withHost(io, async (host) =>
      (await host.api.invoke("memory.core", {}, { session: { folder: io.project } })) as { text: string; project: string },
    );
    expect(core.project).toBe("elmwood-garden");
    expect(context).toBe(`${SESSION_START_LEAD}\n\n${core.text}`);
    expect(context).toContain(procedure);
    expect(context).toContain("Water the raised beds before nine in the morning.");
    expect(context).toContain("Elmwood Garden, shelf");
    expect(context).toContain(fact);

    // The same library, the same bytes.
    const second = await hook("session-start", input("SessionStart", io, { session_id: "another-session" }), io);
    expect(second.stdout).toBe(first.stdout);
  });

  it("goes through the registry: the read is audited", async () => {
    const io = throwaway();
    await seed(io);
    await hook("session-start", input("SessionStart", io), io);
    await withHost(io, async (host) => {
      expect(host.store.listAudit(50).some((entry) => entry.tool === "memory.core")).toBe(true);
    });
  });

  it("says in one line when proposals wait and a consolidation is due", async () => {
    const io = throwaway();
    const { fact } = await seed(io);
    await withHost(io, async (host) => {
      await host.ports.review.propose({ tool: "memory.retire", payload: { call: fact }, summary: "Retire it" });
      host.store.writeValue("consolidation.sessionsSince", 10);
    });
    const context = contextOf((await hook("session-start", input("SessionStart", io), io)).stdout);
    expect(context.endsWith("Reverie: 1 proposal waits in review (/reverie:review). A consolidation pass is due (/reverie:dream).")).toBe(true);
  });

  it("a folder no project holds gets the block with no project slot", async () => {
    const io = throwaway();
    await seed(io);
    const elsewhere = join(io.dir, "elsewhere");
    mkdirSync(elsewhere);
    const context = contextOf((await hook("session-start", input("SessionStart", io, { cwd: elsewhere }), io)).stdout);
    expect(context).toContain("Water the raised beds");
    expect(context).not.toContain("Elmwood Garden, shelf");
  });

  it("still reads while incognito is on, and says that nothing is written", async () => {
    const io = throwaway();
    await seed(io);
    await withHost(io, (host) => host.ports.settings.set({ incognito: true }));
    const context = contextOf((await hook("session-start", input("SessionStart", io), io)).stdout);
    expect(context).toContain("Water the raised beds");
    expect(context.endsWith(INCOGNITO_LINE)).toBe(true);
  });
});

describe("reverie hook session-start, the update offer", () => {
  /**
   * Claude Code's record of the plugin, in a throwaway CLAUDE_CONFIG_DIR, and
   * a fetch that fails the test if it is called: the offer reads the cached
   * answer beside host.db, written here as fresh, and nothing reaches GitHub.
   */
  function withPlugin(io: Captured, version: string): void {
    const claude = join(io.dir, "claude");
    mkdirSync(join(claude, "plugins"), { recursive: true });
    writeFileSync(
      join(claude, "plugins", "installed_plugins.json"),
      JSON.stringify({ plugins: { "reverie@reverie": [{ scope: "user", version, installPath: "/x" }] } }),
    );
    io.env = { ...io.env, CLAUDE_CONFIG_DIR: claude };
    io.fetch = (async () => {
      throw new Error("the hook reached the network");
    }) as typeof fetch;
  }

  function cachedRelease(io: Captured, tag: string): void {
    writeFileSync(
      join(io.dir, "update-check.json"),
      JSON.stringify({
        checkedAt: new Date().toISOString(),
        latest: { version: tag.replace(/^v/, ""), tag, url: `https://github.com/starside-io/reverie/releases/tag/${tag}`, publishedAt: null },
        error: null,
      }),
    );
  }

  it("says nothing about updates while the check is off, whatever the cache holds", async () => {
    const io = throwaway();
    await withHost(io, async () => undefined);
    withPlugin(io, "0.0.1");
    cachedRelease(io, "v0.0.2");
    expect(await hook("session-start", input("SessionStart", io, { source: "startup" }), io)).toEqual({ code: 0, stdout: "" });
  });

  it("offers a newer release once the owner turned the check on, at startup only", async () => {
    const io = throwaway();
    await withHost(io, async (host) => host.store.writeSetting("updates.check", true));
    withPlugin(io, "0.0.1");
    cachedRelease(io, "v0.0.2");

    const context = contextOf((await hook("session-start", input("SessionStart", io, { source: "startup" }), io)).stdout);
    expect(context).toMatch(/^Reverie: version 0\.0\.2 of the plugin is out \(0\.0\.1 is installed\)/);
    expect(context).toContain("claude plugin marketplace update reverie && claude plugin update reverie@reverie");

    for (const source of ["resume", "clear", "compact"]) {
      expect((await hook("session-start", input("SessionStart", io, { source }), io)).stdout, source).toBe("");
    }
  });

  it("offers nothing when the installed plugin is current", async () => {
    const io = throwaway();
    await withHost(io, async (host) => host.store.writeSetting("updates.check", true));
    withPlugin(io, "0.0.2");
    cachedRelease(io, "v0.0.2");
    expect((await hook("session-start", input("SessionStart", io, { source: "startup" }), io)).stdout).toBe("");
  });
});

describe("reverie hook pre-compact", () => {
  it("asks the compaction summary to carry the session note reminder, and writes nothing", async () => {
    const io = throwaway();
    await seed(io);
    const before = await withHost(io, async (host) => ({
      notes: await host.silo.sessionNote.count(),
      events: host.store.listEvents().length,
    }));
    const result = await hook("pre-compact", input("PreCompact", io, { trigger: "auto", custom_instructions: null }), io);
    expect(result).toEqual({ code: 0, stdout: PRE_COMPACT_TEXT });
    expect(result.stdout).toContain("memory_session_note");
    await withHost(io, async (host) => {
      expect(await host.silo.sessionNote.count()).toBe(before.notes);
      expect(host.store.listEvents().length).toBe(before.events);
    });
  });

  it("says nothing while incognito is on", async () => {
    const io = throwaway();
    await seed(io);
    await withHost(io, (host) => host.ports.settings.set({ incognito: true }));
    expect(await hook("pre-compact", input("PreCompact", io), io)).toEqual({ code: 0, stdout: "" });
  });
});

describe("reverie hook session-end", () => {
  it("marks the session ready for extraction with a pointer to its transcript, and prints nothing", async () => {
    const io = throwaway();
    await seed(io);
    const transcript = join(io.dir, "transcripts", "3f6c2a1e.jsonl");
    expect(await hook("session-end", input("SessionEnd", io, { reason: "prompt_input_exit" }), io)).toEqual({
      code: 0,
      stdout: "",
    });
    await withHost(io, async (host) => {
      const session = "3f6c2a1e-0b7d-4e5f-9a8b-1c2d3e4f5a6b";
      expect(await coreTools.shared.readyForExtraction(host.ports)).toEqual([session]);
      expect(await coreTools.shared.transcriptPointers(host.ports)).toEqual({ [session]: transcript });
      expect(host.store.listEvents().filter((event) => event.name === "host.session.ended")).toHaveLength(1);
    });
    // A pointer only: the file was never there to be read, and nothing made it.
    expect(existsSync(transcript)).toBe(false);
  });

  it("marks nothing and records nothing while incognito is on", async () => {
    const io = throwaway();
    await seed(io);
    await withHost(io, (host) => host.ports.settings.set({ incognito: true }));
    expect(await hook("session-end", input("SessionEnd", io), io)).toEqual({ code: 0, stdout: "" });
    await withHost(io, async (host) => {
      expect(await coreTools.shared.readyForExtraction(host.ports)).toEqual([]);
      expect(host.store.listEvents().filter((event) => event.name === "host.session.ended")).toEqual([]);
    });
  });

  it("does nothing without a session id", async () => {
    const io = throwaway();
    await seed(io);
    const stdin = JSON.stringify({ hook_event_name: "SessionEnd", cwd: io.project });
    const env = { ...io.env };
    delete env["CLAUDE_CODE_SESSION_ID"];
    delete env["REVERIE_SESSION_ID"];
    expect(await hook("session-end", stdin, { ...io, env })).toEqual({ code: 0, stdout: "" });
    await withHost(io, async (host) => {
      expect(await coreTools.shared.readyForExtraction(host.ports)).toEqual([]);
    });
  });
});

describe("reverie hook, on bad input and broken files", () => {
  it("exits 0 with nothing on stdout for malformed stdin, another event's JSON, or an unknown event", async () => {
    const io = throwaway();
    await seed(io);
    for (const stdin of ["", "not json", "[1,2]", "null", '"text"', input("SessionEnd", io)]) {
      expect(await hook("session-start", stdin, io)).toEqual({ code: 0, stdout: "" });
    }
    expect(await hook("pre-compact", "{", io)).toEqual({ code: 0, stdout: "" });
    expect(await hook("session-end", "{", io)).toEqual({ code: 0, stdout: "" });
    expect(await hook("user-prompt", input("UserPromptSubmit", io), io)).toEqual({ code: 0, stdout: "" });
    expect(await hook(undefined as unknown as string, input("SessionStart", io), io)).toEqual({ code: 0, stdout: "" });
    await withHost(io, async (host) => {
      expect(await coreTools.shared.readyForExtraction(host.ports)).toEqual([]);
    });
  });

  it("exits 0 with nothing on stdout when the silo is not a database", async () => {
    const io = throwaway();
    writeFileSync(join(io.dir, "reverie.db"), "this is not a sqlite file");
    writeFileSync(join(io.dir, "host.db"), "nor is this");
    for (const [event, name] of [
      ["session-start", "SessionStart"],
      ["pre-compact", "PreCompact"],
      ["session-end", "SessionEnd"],
    ] as const) {
      expect(await hook(event, input(name, io), io)).toEqual({ code: 0, stdout: "" });
    }
  });
});

function runProcess(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stdin: string },
): Promise<{ code: number | null; stdout: string; ms: number }> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, ms: Date.now() - started }));
    child.stdin.end(options.stdin);
  });
}

describe("reverie hook, as Claude Code runs it", () => {
  it("reads the hook JSON on stdin and prints only the payload, well inside the timeout", async () => {
    const io = throwaway();
    await seed(io);
    const result = await runProcess(process.execPath, ["--import", "tsx", "src/cli.ts", "hook", "session-start"], {
      cwd: APP_ROOT,
      env: io.env,
      stdin: input("SessionStart", io),
    });
    expect(result.code).toBe(0);
    expect(result.stdout.endsWith("\n")).toBe(true);
    expect(contextOf(result.stdout.trim())).toContain("Water the raised beds");
    expect(result.ms).toBeLessThan(10_000);
  });

  it("exits 0 silently on malformed stdin", async () => {
    const io = throwaway();
    await seed(io);
    const result = await runProcess(process.execPath, ["--import", "tsx", "src/cli.ts", "hook", "session-end"], {
      cwd: APP_ROOT,
      env: io.env,
      stdin: "{ not json",
    });
    expect(result).toMatchObject({ code: 0, stdout: "" });
  });
});

describe("plugin-bootstrap.mjs hook, on a checkout that is not built", () => {
  /**
   * A copy of the script alone, so it sees no build output. A build lock is
   * already in place, as if another session had started the build, so the
   * hook starts no second one: this checks what it says, never runs pnpm.
   */
  function unbuiltCheckout(): string {
    const root = mkdtempSync(join(tmpdir(), "reverie-unbuilt-"));
    mkdirSync(join(root, "scripts"));
    cpSync(join(REPO_ROOT, "scripts", "plugin-bootstrap.mjs"), join(root, "scripts", "plugin-bootstrap.mjs"));
    mkdirSync(join(root, ".plugin-build.lock"));
    return root;
  }

  it("says in one line at session-start that it is building, and nothing for the other two", async () => {
    const root = unbuiltCheckout();
    const io = throwaway();
    const script = join(root, "scripts", "plugin-bootstrap.mjs");

    const start = await runProcess(process.execPath, [script, "hook", "session-start"], {
      cwd: io.project,
      env: io.env,
      stdin: input("SessionStart", io),
    });
    expect(start.code).toBe(0);
    const context = contextOf(start.stdout.trim());
    expect(context).toContain("building itself in the background");
    expect(context.split("\n")).toHaveLength(1);

    for (const [event, name] of [
      ["pre-compact", "PreCompact"],
      ["session-end", "SessionEnd"],
    ] as const) {
      expect(
        await runProcess(process.execPath, [script, "hook", event], { cwd: io.project, env: io.env, stdin: input(name, io) }),
      ).toMatchObject({ code: 0, stdout: "" });
    }
    expect(
      await runProcess(process.execPath, [script, "hook", "no-such-event"], { cwd: io.project, env: io.env, stdin: "{}" }),
    ).toMatchObject({ code: 0, stdout: "" });

    // No library was opened or made.
    expect(readdirSync(io.dir).sort()).toEqual(["elmwood-garden"]);
  });
});

describe("hooks/hooks.json", () => {
  it("runs SessionStart after a startup, a resume, a clear and a compaction, so the core block comes back each time", () => {
    const config = JSON.parse(readFileSync(join(REPO_ROOT, "hooks", "hooks.json"), "utf8")) as {
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
    };
    const start = config.hooks["SessionStart"] ?? [];
    expect(start).toHaveLength(1);
    expect((start[0]?.matcher ?? "").split("|").sort()).toEqual(["clear", "compact", "resume", "startup"]);
    expect(start[0]?.hooks[0]?.command).toContain("hook session-start");
  });
});
