import { spawn } from "node:child_process";
import { existsSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
  UI_DIR_ENV,
  verifySnapshot,
  type MiniHost,
} from "@reverie/mini-host";

import { formatReport, runEval, writeReport } from "./eval.js";
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

  serve [--port <n>]       Start the host: the UI, POST /rpc and /host, on
                           127.0.0.1 only. One at a time: refuses while
                           another host is running, and names it.
  restart                  Stop the running host and start it the same way
                           again, on the code as it is now.
  mcp                      Start the stdio MCP server for an assistant.
  status                   Where the files are and what is in them.
  tools                    List the tool surface.
  verify <file> [--keep]   Import a snapshot into a throwaway silo, export it
                           back out, and diff the two. Touches no live file.
  import <file|folder>     Read a snapshot, a markdown mirror folder or a
                           Claude Code memory directory into the live silo.
                           Merge: nothing is deleted; an edited mirror file
                           comes back as a new version, an unchanged one is
                           left alone. A backup of the silo is taken first.
        [--mirror]         The folder is a markdown mirror (the default for a
                           folder, unless it holds MEMORY.md and no mirror).
        [--claude-code]    The folder is a Claude Code memory directory:
                           imported once, never written to.
        [--project <slug>] For --claude-code: the registered project it
                           belongs to. Without one, everything lands global.
        [--dry-run]        Say what it would do, file by file. Writes nothing.
        [--replace --yes]  Delete the library first. Names what it will
                           destroy, and refuses without --yes.
  export <file|folder>     Write the whole library to a snapshot file.
        [--mirror]         Write it as a markdown mirror folder instead: one
                           folder per section, one per shelf, one file per
                           memory. Files the mirror did not write are never
                           touched. The default when the path is a folder.
  reindex                  Rebuild the search index from the memory rows and
                           check it, then bring the vectors up to date: finish
                           a re-embed left half done, compute the missing
                           ones and refresh the stale ones. For a file
                           restored from a backup, or after an embed failed.
  dream                    Whether a consolidation pass is due and how many
                           finished sessions wait for extraction. The library
                           never calls a model: an assistant runs both.
  eval                     Score recall on the fixture corpus (eval/corpus.json)
                           in a throwaway silo: full text alone, then with each
                           embedder. Scores, not gates. Touches no live file.
        [--embedder <model>] An embedding.model to score; repeat for more.
                           Defaults to reverie-lexical-v1, the built-in one.
                           ollama/<model> or openai/<model> use a local
                           endpoint on loopback.
        [--endpoint <url>] The local endpoint, when not on its default port.
        [--corpus <file>]  Another corpus.
        [--out <folder>]   Write results.json and RESULTS.md there.
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

    case "export":
      return exportCommand(argv, io);

    case "reindex":
      return withHost(io, async (host) => {
        const started = Date.now();
        await storage.reindexSearch(host.silo);
        const integrity = await storage.searchIntegrity(host.silo);
        const memories = await host.silo.memory.count();
        const lines = [
          `Rebuilt the search index in ${Date.now() - started}ms`,
          `  memories  ${memories}`,
          `  check     ${integrity.status === "ok" ? "matches its rows" : `drifted: ${integrity.detail}`}`,
        ];
        let vectorsOk = true;
        try {
          const report = await host.embedding.resume();
          if (report.ran === "none" && report.model === null) {
            lines.push("  vectors   off: no embedding model, recall runs on full text alone");
          } else if (report.ran === "none") {
            vectorsOk = false;
            lines.push(`  vectors   ${report.model}: ${report.reason ?? "nothing to compute with"}`);
          } else {
            vectorsOk = report.complete;
            lines.push(
              `  vectors   ${report.model} (dim ${report.dim ?? "?"}): ${report.ran === "reembed" ? "finished the re-embed, " : ""}${report.embedded} written, ${report.removed} of another model or dim removed${report.complete ? "" : `, ${report.failed} still missing: ${report.reason ?? "unknown reason"}`}`,
            );
          }
        } catch (error) {
          vectorsOk = false;
          lines.push(`  vectors   ${error instanceof Error ? error.message : String(error)}`);
        }
        io.out([...lines, ""].join("\n"));
        return integrity.status === "ok" && vectorsOk ? 0 : 1;
      });

    case "dream":
      return dream(io);

    case "eval":
      return evalCommand(argv, io);

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

/**
 * The built UI: REVERIE_UI_DIR when set, else beside this binary in a package
 * (ui/), else the workspace's packages/ui/dist when run from a checkout. A
 * missing build is not fatal: the tools answer over /rpc and MCP either way,
 * and `/` says the UI is not built. Lifted from Fellowship's cli.ts.
 */
export function uiDir(env: NodeJS.ProcessEnv): string {
  const override = env[UI_DIR_ENV]?.trim();
  if (override) return override;
  const here = dirname(fileURLToPath(import.meta.url));
  const packaged = resolve(here, "..", "ui");
  if (existsSync(join(packaged, "index.html"))) return packaged;
  return resolve(here, "..", "..", "..", "packages", "ui", "dist");
}

async function serve(argv: string[], io: Io): Promise<number> {
  // No flag means the host decides: REVERIE_PORT, else the default.
  const port = portFrom(argv);
  const ui = uiDir(io.env);
  let running: Awaited<ReturnType<typeof serveMiniHost>>;
  try {
    running = await serveMiniHost({ env: io.env, uiDir: ui, ...(port === undefined ? {} : { port }) });
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
      `  ui       ${existsSync(join(ui, "index.html")) ? join(ui, "index.html") : `not built (${ui})`}`,
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
    const vectors = await host.embedding.status();

    io.out(
      [
        `silo        ${host.siloPath}`,
        `host.db     ${host.hostPath}`,
        `host        ${lock ? `running on ${lock.url ?? "a port not bound yet"} (pid ${lock.pid})` : "not running"}`,
        `memories    ${count("active")} active, ${count("superseded")} superseded, ${count("retired")} retired`,
        `library     ${sections} sections, ${shelves} shelves`,
        `to review   ${host.store.listProposals("pending").length}`,
        `recall      ${recallLine(config.embedding.model, vectors)}`,
        `incognito   ${config.incognito ? "on: nothing is written" : "off"}`,
        `tools       ${host.api.describe().length}`,
        "",
      ].join("\n"),
    );
    return 0;
  });
}

/** How recall finds candidates, in one line: what the vector leg would say. */
function recallLine(model: string | null, vectors: Awaited<ReturnType<MiniHost["embedding"]["status"]>>): string {
  if (vectors.reembed) {
    const left = vectors.reembed.remaining === undefined ? "" : `, ${vectors.reembed.remaining} to go`;
    return `full text only while re-embedding with ${vectors.reembed.model}${left}${vectors.reembed.lastError ? ` (stopped: ${vectors.reembed.lastError} Run reverie reindex to resume.)` : ""}`;
  }
  if (!model) return "full text only, no embedding model";
  if (vectors.missing > 0) return `full text only until ${vectors.missing} missing vectors of ${model} are filled (reverie reindex)`;
  return `vectors (${model}, dim ${vectors.dim ?? "?"}) and full text`;
}

interface DryRun {
  wouldDestroy: Record<string, number> | null;
  acknowledgement: string | null;
  folder?: FolderReport;
}

interface FolderReport {
  files: number;
  memories: number;
  unchanged: number;
  applied: number;
  conflicts: Array<{ path: string; message: string }>;
  problems: Array<{ path: string; message: string }>;
  forgotten: Array<{ path: string; message: string }>;
  notes: Array<{ path: string; action: string; call?: string; message?: string }>;
}

function optionValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  const value = index === -1 ? undefined : argv[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function isFolder(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory();
}

/** What a folder is, by flag, else by what it holds: a mirror has .reverie/library.json, a Claude Code directory MEMORY.md. */
function folderKind(argv: string[], path: string): "markdown" | "claude_code" {
  if (argv.includes("--claude-code")) return "claude_code";
  if (argv.includes("--mirror")) return "markdown";
  if (existsSync(join(path, ".reverie", "library.json"))) return "markdown";
  return existsSync(join(path, "MEMORY.md")) ? "claude_code" : "markdown";
}

/** One line per file that needs the owner's eye, and a count of the rest. */
function folderLines(report: FolderReport | undefined): string[] {
  if (!report) return [];
  const lines = [
    `  files          ${report.files}`,
    `  unchanged      ${report.unchanged}`,
    `  taken in       ${report.applied}`,
  ];
  for (const entry of report.conflicts) lines.push(`  conflict   ${entry.path}: ${entry.message}`);
  for (const entry of report.problems) lines.push(`  problem    ${entry.path}: ${entry.message}`);
  for (const entry of report.forgotten) lines.push(`  forgotten  ${entry.path}: ${entry.message}`);
  for (const note of report.notes) {
    lines.push(`  ${note.action.padEnd(10)} ${note.path}${note.call ? ` as ${note.call}` : ""}${note.message ? `: ${note.message}` : ""}`);
  }
  return lines;
}

/**
 * Import through memory.import: a snapshot file, a markdown mirror folder,
 * or a Claude Code memory directory. The tool takes the backup of the silo
 * before it writes anything (docs/SPEC.md section 25: before every import).
 * A replace keeps the tool's handshake: the dry run names what it destroys
 * and hands back an acknowledgement, the owner says yes with --yes, and the
 * import runs with that acknowledgement.
 */
async function importCommand(argv: string[], io: Io): Promise<number> {
  const target = argv[1];
  if (!target || target.startsWith("--")) {
    io.err("Usage: reverie import <snapshot.json|folder> [--mirror|--claude-code [--project <slug>]] [--dry-run] [--replace --yes]\n");
    return 2;
  }

  const replace = argv.includes("--replace");
  const mode = replace ? "replace" : "merge";
  const path = resolve(io.cwd, target);
  const folder = isFolder(path);
  const project = optionValue(argv, "--project");
  const source: Record<string, unknown> = folder
    ? { from: folderKind(argv, path), folder: path, ...(project ? { project } : {}) }
    : { from: "snapshot", snapshot: JSON.parse(readFileSync(path, "utf8")) as unknown };

  return withHost(io, async (host) => {
    if (argv.includes("--dry-run")) {
      const plan = (await host.api.invoke("memory.import", { ...source, mode, dryRun: true, confirmedByUser: true })) as DryRun;
      io.out([`Would ${mode} into ${host.siloPath}. Nothing was written.`, ...folderLines(plan.folder), ""].join("\n"));
      return 0;
    }

    let acknowledge: string | undefined;
    if (replace) {
      const dryRun = (await host.api.invoke("memory.import", {
        ...source,
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

    const backups = join(dirname(host.siloPath), "backups");
    try {
      const result = (await host.api.invoke("memory.import", {
        ...source,
        mode,
        confirmedByUser: true,
        ...(acknowledge ? { acknowledge } : {}),
      })) as { counts: Record<string, number>; needsEmbedding: number; backup: string | null; folder?: FolderReport; links?: number };

      io.out(
        [
          result.backup ? `Backed up the silo to ${join(backups, result.backup)}` : "No backup was taken: this host offers none.",
          `${mode} into ${host.siloPath}`,
          ...(source["from"] === "claude_code"
            ? [`  memories       ${result.counts["memories"] ?? 0}`, `  links          ${result.links ?? 0}`]
            : Object.entries(result.counts).map(([name, value]) => `  ${name.padEnd(14)} ${value}`)),
          ...folderLines(result.folder),
          "",
        ].join("\n"),
      );
      return 0;
    } catch (error) {
      if (error instanceof coreTools.ToolError) {
        io.err(`${error.code}: ${error.message}\nAny backup taken before the import is in ${backups}.\n`);
        return 1;
      }
      throw error;
    }
  });
}

/** A snapshot file, or a markdown mirror folder through memory.export. */
async function exportCommand(argv: string[], io: Io): Promise<number> {
  const target = argv[1];
  if (!target || target.startsWith("--")) {
    io.err("Usage: reverie export <snapshot.json|folder> [--mirror]\n");
    return 2;
  }
  const path = resolve(io.cwd, target);
  const mirror = argv.includes("--mirror") || isFolder(path);
  return withHost(io, async (host) => {
    if (mirror) {
      try {
        const result = (await host.api.invoke("memory.export", { to: "markdown", folder: path })) as {
          memories: number;
          files: number;
          mirror: { written: number; unchanged: number; removed: number; kept: Array<{ path: string; reason: string }> };
        };
        io.out(
          [
            `Wrote the mirror to ${path}: ${result.memories} memories in ${result.files} files.`,
            `  written        ${result.mirror.written}`,
            `  unchanged      ${result.mirror.unchanged}`,
            `  removed        ${result.mirror.removed}`,
            ...result.mirror.kept.map((entry) => `  kept       ${entry.path}: ${entry.reason}`),
            "",
          ].join("\n"),
        );
        return 0;
      } catch (error) {
        if (error instanceof coreTools.ToolError) {
          io.err(`${error.code}: ${error.message}\n`);
          return 1;
        }
        throw error;
      }
    }
    const result = (await host.api.invoke("memory.export", {})) as {
      snapshot: unknown;
      memories: number;
      versions: number;
    };
    writeFileSync(path, JSON.stringify(result.snapshot));
    io.out(`Wrote ${path}: ${result.memories} memories, ${result.versions} versions, and everything attached.\n`);
    return 0;
  });
}

/** Every value given for a repeatable option. */
function optionValues(argv: string[], name: string): string[] {
  const out: string[] = [];
  argv.forEach((arg, index) => {
    const value = argv[index + 1];
    if (arg === name && value && !value.startsWith("--")) out.push(value);
  });
  return out;
}

/** The fixture corpus in a checkout: eval/corpus.json at the repository root. */
export function defaultCorpusPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "..", "eval", "corpus.json");
}

/**
 * The recall evals (docs/SPEC.md section 16). A throwaway silo built from the
 * corpus, scored FTS only and with each embedder. A score is never a failure:
 * this exits 0 whatever the numbers say, and 1 only when the run itself could
 * not happen (an unusable corpus, an embedder that cannot be reached).
 */
async function evalCommand(argv: string[], io: Io): Promise<number> {
  const corpus = optionValue(argv, "--corpus");
  const out = optionValue(argv, "--out");
  const endpoint = optionValue(argv, "--endpoint");
  const embedders = optionValues(argv, "--embedder");
  try {
    const report = await runEval({
      corpusPath: corpus ? resolve(io.cwd, corpus) : defaultCorpusPath(),
      embedders: embedders.length > 0 ? embedders : ["reverie-lexical-v1"],
      ...(endpoint ? { endpoint } : {}),
      log: (line) => io.err(`${line}\n`),
    });
    if (out) {
      const written = writeReport(report, resolve(io.cwd, out));
      io.err(`Wrote ${written.markdown} and ${written.json}\n`);
    }
    io.out(formatReport(report));
    return 0;
  } catch (error) {
    io.err(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
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
