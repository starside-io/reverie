import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { storage, tools as coreTools } from "@reverie/core";
import {
  HostAlreadyRunning,
  PARENT_PID_ENV,
  formatVerify,
  healthPid,
  hostLockPath,
  liveHostLock,
  processAlive,
  resolveHostDbPath,
  runStdioServer,
  serveMiniHost,
  sessionFromEnvironment,
  startMiniHost,
  verifySnapshot,
  type MiniHost,
} from "@reverie/mini-host";

import { readStdin, runHook } from "./hook.js";

/**
 * The standalone binary. docs/SPEC.md section 21. Lifted from Fellowship's
 * apps/fellowship/src/cli.ts.
 *
 *   reverie serve     one process: the silo, the ports, /rpc and /host
 *   reverie mcp       the same module over stdio, for an assistant
 *   reverie status    where the files are, and what is in them
 *   reverie tools     the surface, one line each
 *   reverie restart   stop the running host and start it again on this code
 *   reverie hook      one Claude Code plugin hook, reading its JSON on stdin
 *
 * plus the maintenance commands: verify, import, export, reindex, dream. Each
 * one goes through the registry or through a core storage function: none
 * builds SQL of its own. There is no database server to start first: the
 * files are opened by whichever of these runs.
 */

export const USAGE = `reverie <command>

  serve [--port <n>]       Start the host: POST /rpc and /host, on 127.0.0.1
                           only. One at a time: refuses while another host is
                           running, and names it.
  restart                  Stop the running host and start it the same way
                           again, on the code as it is now.
  mcp                      Start the stdio MCP server for an assistant.
  status                   Where the files are and what is in them.
  tools                    List the tool surface.
  verify <file> [--keep]   Import a snapshot into a throwaway silo, export it
                           back out, and diff the two. Touches no live file.
  import <file>            Read a snapshot into the live silo. Merge: the file
                           wins row by row and nothing else is touched. A
                           backup of the silo is taken first.
        [--replace --yes]  Delete the library first. Names what it will
                           destroy, and refuses without --yes.
  export <file>            Write the whole library to a snapshot file.
  reindex                  Rebuild the search index from the memory rows and
                           check it. For a file restored from a backup.
  dream                    Whether a consolidation pass is due and how many
                           finished sessions wait for extraction. The library
                           never calls a model: an assistant runs both.
  hook <event>             One Claude Code plugin hook: session-start,
                           pre-compact or session-end. Reads the hook JSON on
                           stdin, prints the hook payload or nothing, and
                           always exits 0.
`;

export interface Io {
  env: NodeJS.ProcessEnv;
  cwd: string;
  out(text: string): void;
  err(text: string): void;
  /** All of stdin, for `hook`. Absent reads as empty. */
  stdin?: () => Promise<string>;
}

export const processIo: Io = {
  env: process.env,
  cwd: process.cwd(),
  out: (text) => void process.stdout.write(text),
  err: (text) => void process.stderr.write(text),
  stdin: () => readStdin(),
};

function portFrom(argv: string[]): number | undefined {
  const index = argv.indexOf("--port");
  if (index === -1) return undefined;
  const value = Number(argv[index + 1]);
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

async function withHost<T>(io: Io, run: (host: MiniHost) => Promise<T>): Promise<T> {
  const host = await startMiniHost({ env: io.env });
  try {
    return await run(host);
  } finally {
    await host.close();
  }
}

/**
 * Runs one command. Returns the exit code, or -1 for a command that keeps
 * the process up (serve, mcp).
 */
export async function run(argv: string[], io: Io = processIo): Promise<number> {
  const command = argv[0] ?? "help";

  switch (command) {
    case "serve":
      return serve(argv, io);

    case "restart":
      return restartHost(io);

    case "mcp": {
      // stdout is the protocol here, so nothing else may write to it.
      await runStdioServer({ env: io.env, session: sessionFromEnvironment(io.env, io.cwd) });
      return -1;
    }

    case "status":
      return status(io);

    case "tools":
      return withHost(io, async (host) => {
        for (const tool of host.api.describe()) {
          io.out(`${tool.kind.padEnd(9)} ${tool.name.padEnd(26)} ${tool.title}\n`);
        }
        return 0;
      });

    case "verify": {
      const file = argv[1];
      if (!file) {
        io.err("Usage: reverie verify <snapshot.json> [--keep]\n");
        return 2;
      }
      // A throwaway silo, so a file nobody has checked yet never gets near
      // the real one.
      const result = await verifySnapshot(resolve(io.cwd, file), { keep: argv.includes("--keep") });
      io.out(formatVerify(result));
      if (argv.includes("--keep")) io.out(`kept            ${result.siloPath}\n`);
      return result.ok ? 0 : 1;
    }

    case "import":
      return importCommand(argv, io);

    case "export": {
      const file = argv[1];
      if (!file) {
        io.err("Usage: reverie export <snapshot.json>\n");
        return 2;
      }
      return withHost(io, async (host) => {
        const result = (await host.api.invoke("memory.export", {})) as {
          snapshot: unknown;
          memories: number;
          versions: number;
        };
        const path = resolve(io.cwd, file);
        writeFileSync(path, JSON.stringify(result.snapshot));
        io.out(`Wrote ${path}: ${result.memories} memories, ${result.versions} versions, and everything attached.\n`);
        return 0;
      });
    }

    case "reindex":
      return withHost(io, async (host) => {
        const started = Date.now();
        await storage.reindexSearch(host.silo);
        const integrity = await storage.searchIntegrity(host.silo);
        const memories = await host.silo.memory.count();
        io.out(
          [
            `Rebuilt the search index in ${Date.now() - started}ms`,
            `  memories  ${memories}`,
            `  check     ${integrity.status === "ok" ? "matches its rows" : `drifted: ${integrity.detail}`}`,
            "",
          ].join("\n"),
        );
        return integrity.status === "ok" ? 0 : 1;
      });

    case "dream":
      return dream(io);

    case "hook": {
      // stdout is the hook payload here, and a hook never fails the session:
      // runHook always answers 0, with its payload or with nothing.
      const stdin = io.stdin ? await io.stdin().catch(() => "") : "";
      return runHook(argv[1], stdin, io);
    }

    case "--help":
    case "-h":
    case "help": {
      io.out(USAGE);
      return 0;
    }

    default: {
      io.err(`Unknown command "${command}".\n\n${USAGE}`);
      return 2;
    }
  }
}

async function serve(argv: string[], io: Io): Promise<number> {
  // No flag means the host decides: REVERIE_PORT, else the default.
  const port = portFrom(argv);
  let running: Awaited<ReturnType<typeof serveMiniHost>>;
  try {
    running = await serveMiniHost({ env: io.env, ...(port === undefined ? {} : { port }) });
  } catch (error) {
    if (error instanceof HostAlreadyRunning) {
      io.err(`${error.message}\n`);
      return 3;
    }
    throw error;
  }
  io.out(
    [
      `Reverie is up on ${running.url}`,
      `  silo     ${running.host.siloPath}`,
      `  host.db  ${running.host.hostPath}`,
      `  tools    ${running.host.api.describe().length}`,
      "",
      "Ctrl+C to stop.",
      "",
    ].join("\n"),
  );

  const stop = async () => {
    await running.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
  process.on("SIGHUP", () => void stop());

  // Started by a desktop shell: go when it goes, even if it crashed and
  // never got to stop this process. No orphan keeps the silo open.
  const parent = Number(io.env[PARENT_PID_ENV]);
  if (Number.isInteger(parent) && parent > 1) {
    setInterval(() => {
      if (!processAlive(parent)) void stop();
    }, 2000).unref();
  }
  return -1;
}

async function status(io: Io): Promise<number> {
  const lock = await liveHostLock(hostLockPath(resolveHostDbPath(io.env)));
  return withHost(io, async (host) => {
    const [states, sections, shelves] = await Promise.all([
      host.silo.memory.groupBy({ by: ["state"], _count: { _all: true } }),
      host.silo.section.count(),
      host.silo.shelf.count(),
    ]);
    const count = (state: string) => states.find((row) => row.state === state)?._count._all ?? 0;
    const config = host.config();

    io.out(
      [
        `silo        ${host.siloPath}`,
        `host.db     ${host.hostPath}`,
        `host        ${lock ? `running on ${lock.url ?? "a port not bound yet"} (pid ${lock.pid})` : "not running"}`,
        `memories    ${count("active")} active, ${count("superseded")} superseded, ${count("retired")} retired`,
        `library     ${sections} sections, ${shelves} shelves`,
        `to review   ${host.store.listProposals("pending").length}`,
        `recall      ${config.embedding.model ? `vectors (${config.embedding.model}) and full text` : "full text only, no embedding model"}`,
        `incognito   ${config.incognito ? "on: nothing is written" : "off"}`,
        `tools       ${host.api.describe().length}`,
        "",
      ].join("\n"),
    );
    return 0;
  });
}

interface DryRun {
  wouldDestroy: Record<string, number> | null;
  acknowledgement: string | null;
}

/**
 * Import through memory.import, with a backup of the silo first (docs/SPEC.md
 * section 25: before every import). A replace keeps the tool's handshake: the
 * dry run names what it destroys and hands back an acknowledgement, the owner
 * says yes with --yes, and the import runs with that acknowledgement.
 */
async function importCommand(argv: string[], io: Io): Promise<number> {
  const file = argv[1];
  if (!file || file.startsWith("--")) {
    io.err("Usage: reverie import <snapshot.json> [--replace --yes]\n");
    return 2;
  }

  const replace = argv.includes("--replace");
  const mode = replace ? "replace" : "merge";
  const snapshot: unknown = JSON.parse(readFileSync(resolve(io.cwd, file), "utf8"));

  return withHost(io, async (host) => {
    let acknowledge: string | undefined;
    if (replace) {
      const dryRun = (await host.api.invoke("memory.import", {
        snapshot,
        mode,
        dryRun: true,
        confirmedByUser: true,
      })) as DryRun;

      const counts = Object.entries(dryRun.wouldDestroy ?? {})
        .filter(([, value]) => value > 0)
        .map(([name, value]) => `  ${name.padEnd(14)} ${value}`);

      io.out(
        [
          `This will destroy everything in ${host.siloPath}:`,
          ...(counts.length > 0 ? counts : ["  nothing, the library is empty"]),
          "",
        ].join("\n"),
      );

      if (!argv.includes("--yes")) {
        io.err("Refusing a replace without --yes. Nothing was written.\n");
        return 1;
      }
      acknowledge = dryRun.acknowledgement ?? undefined;
    }

    // A consistent copy, with its search index checked, before anything is
    // written. backupSilo refuses a path that exists, so the name carries the
    // time to the millisecond.
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = join(dirname(host.siloPath), "backups", `reverie-before-import-${stamp}.db`);
    mkdirSync(dirname(backupPath), { recursive: true });
    await storage.backupSilo(host.silo, backupPath);
    io.out(`Backed up the silo to ${backupPath}\n`);

    try {
      const result = (await host.api.invoke("memory.import", {
        snapshot,
        mode,
        confirmedByUser: true,
        ...(acknowledge ? { acknowledge } : {}),
      })) as { counts: Record<string, number>; needsEmbedding: number };

      io.out(
        [
          `${mode} into ${host.siloPath}`,
          ...Object.entries(result.counts).map(([name, value]) => `  ${name.padEnd(14)} ${value}`),
          "",
        ].join("\n"),
      );
      return 0;
    } catch (error) {
      if (error instanceof coreTools.ToolError) {
        io.err(`${error.code}: ${error.message}\nThe backup is at ${backupPath}.\n`);
        return 1;
      }
      throw error;
    }
  });
}

/**
 * The honest minimum. The library never calls a model, and consolidation
 * proposes and never applies (docs/SPEC.md section 24), so there is no pass
 * this binary can run on its own. It reports what core knows (whether the
 * consolidate job is due by consolidateEvery, how many proposals already
 * wait, how many sessions are marked ready for extraction) and names what an
 * assistant runs to extract those sessions and to do the pass.
 */
async function dream(io: Io): Promise<number> {
  return withHost(io, async (host) => {
    const now = new Date();
    const config = host.config();
    const state = await coreTools.shared.readConsolidation(host.ports);
    const due = coreTools.shared.consolidationDue(state, config.consolidateEvery, now);
    const ready = await coreTools.shared.readyForExtraction(host.ports);
    const pending = host.store.listProposals("pending").length;

    io.out(
      [
        `consolidation  ${due ? "due" : "not due"}`,
        `  last run     ${state.lastAt ? state.lastAt.toISOString() : "never"}`,
        `  sessions     ${state.sessionsSince} since, due after ${config.consolidateEvery.sessions} or ${config.consolidateEvery.days} days`,
        `ready to extract  ${ready.length} ${ready.length === 1 ? "session" : "sessions"}${config.incognito ? " (incognito is on: none is read)" : ""}`,
        `to review         ${pending} proposals`,
        "",
        "The library never calls a model, so this command runs no pass. In an assistant",
        "session, run /reverie:dream. For each finished session waiting, it calls",
        "memory_draft_context with job extract and that session (its notes and transcript",
        "turns, a page at a time), drafts the memories worth keeping, and hands them to",
        "memory_propose_draft; the session stops waiting once its last page is proposed.",
        "Then the consolidation pass: memory_draft_context with job consolidate, and its",
        "answer to memory_propose_draft. What either proposes waits in review: nothing",
        "changes until you decide.",
        "",
      ].join("\n"),
    );
    return 0;
  });
}

/**
 * Stops the live host and starts it again the way it was started, detached,
 * logging beside host.db. Used after a change so a host left running does not
 * keep serving yesterday's code.
 */
async function restartHost(io: Io): Promise<number> {
  const lockPath = hostLockPath(resolveHostDbPath(io.env));
  const live = await liveHostLock(lockPath);
  if (!live) {
    io.out("No host is running. Nothing to restart.\n");
    return 0;
  }
  if (live.owner === "desktop") {
    io.out(`The running host (pid ${live.pid}) belongs to the desktop app. Restart the app to restart it.\n`);
    return 0;
  }

  io.out(`Stopping the host on ${live.url ?? "?"} (pid ${live.pid})\n`);
  process.kill(live.pid, "SIGTERM");
  const stopBy = Date.now() + 15_000;
  while (processAlive(live.pid)) {
    if (Date.now() > stopBy) {
      io.err(`pid ${live.pid} did not stop within 15 seconds. Not starting another.\n`);
      return 1;
    }
    await new Promise((done) => setTimeout(done, 200));
  }

  const log = join(dirname(lockPath), "host.log");
  const out = openSync(log, "a");
  const child = spawn(live.execPath, [...live.execArgv, ...live.argv.slice(1)], {
    cwd: existsSync(live.cwd) ? live.cwd : io.cwd,
    env: { ...io.env, ...live.env },
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();

  const port = live.port;
  const upBy = Date.now() + 45_000;
  while (Date.now() < upBy) {
    if (port !== null && child.pid !== undefined && (await healthPid(port)) === child.pid) {
      io.out(`Restarted on ${live.url} (pid ${child.pid}). Log: ${log}\n`);
      return 0;
    }
    if (child.exitCode !== null) break;
    await new Promise((done) => setTimeout(done, 300));
  }
  io.err(`The host did not come back. Its log is ${log}\n`);
  return 1;
}
