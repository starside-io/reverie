#!/usr/bin/env node
// Makes a plugin install runnable. Lifted from Fellowship's
// scripts/plugin-bootstrap.mjs.
//
// A plugin installed from the marketplace is a checkout of this repo with no
// node_modules and no build output, because neither is committed. This script
// is what .mcp.json and hooks/hooks.json run instead of the built files: it
// builds the checkout the first time, then hands over.
//
//   node scripts/plugin-bootstrap.mjs mcp            build if needed, then serve MCP on stdio
//   node scripts/plugin-bootstrap.mjs hook <event>   a plugin hook: session-start,
//                                                    pre-compact or session-end. Not built
//                                                    yet: start the build in the background
//                                                    and, at session-start only, say so.
//                                                    Built: hand stdin to `reverie hook`.
//   node scripts/plugin-bootstrap.mjs build          build now, in the foreground, UI included
//
// No dependencies of its own: it has to run before there are any. stdout is the
// MCP protocol in `mcp` mode and the hook payload in `hook` mode, so every
// line meant for a person goes to stderr or to the log.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lockDir = join(root, ".plugin-build.lock");
const logPath = join(root, ".plugin-build.log");

/**
 * What a plugin session needs: the MCP server, the CLI for the hooks, the
 * markdown mirror the server loads, and the built UI that `reverie serve`
 * hands out and /reverie:open opens. `pnpm build` builds them all; a
 * checkout built before one of them existed is built again, once.
 */
const OUTPUTS = [
  "packages/mini-host/dist/mcp.js",
  "packages/adapter-markdown/dist/index.js",
  "apps/reverie/dist/cli.js",
  "packages/ui/dist/index.html",
];

/** A build that has not finished in this long is taken to have died. */
const STALE_LOCK_MS = 15 * 60_000;

function built() {
  return OUTPUTS.every((path) => existsSync(join(root, path)));
}

function building() {
  if (!existsSync(lockDir)) return false;
  if (Date.now() - statSync(lockDir).mtimeMs > STALE_LOCK_MS) {
    rmSync(lockDir, { recursive: true, force: true });
    return false;
  }
  return true;
}

/**
 * pnpm through corepack, which ships with Node 22, so nothing has to be
 * installed globally first. The version comes from packageManager in
 * package.json.
 */
function pnpm(args, out) {
  const result = spawnSync("corepack", ["pnpm", ...args], {
    cwd: root,
    stdio: ["ignore", out, out],
    env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0", CI: "true" },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`pnpm ${args.join(" ")} failed (exit ${result.status}). Log: ${logPath}`);
  }
}

/** Install, generate the database client, build. Returns false if another build holds the lock. */
function build() {
  try {
    mkdirSync(lockDir);
  } catch {
    return false;
  }
  const out = openSync(logPath, "a");
  try {
    pnpm(["install", "--frozen-lockfile"], out);
    pnpm(["--filter", "@reverie/core", "db:generate"], out);
    pnpm(["build"], out);
    return true;
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

async function waitForBuild(timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (building() && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function ensureBuilt() {
  if (built()) return;
  if (building()) await waitForBuild(10 * 60_000);
  if (built()) return;
  process.stderr.write(
    "Reverie: first run, installing and building (a minute or two). Log: " + logPath + "\n",
  );
  if (!build()) await waitForBuild(10 * 60_000);
  if (!built()) throw new Error(`The build did not finish. Log: ${logPath}`);
}

async function mcp() {
  await ensureBuilt();
  const entry = join(root, "packages/mini-host/dist/mcp.js");
  const { runStdioServer } = await import(pathToFileURL(entry).href);
  await runStdioServer();
}

const HOOK_EVENTS = ["session-start", "pre-compact", "session-end"];

/**
 * Past this the CLI is stopped and the hook says nothing: inside the 10 and 5
 * second timeouts hooks/hooks.json sets.
 */
const HOOK_TIMEOUT_MS = { "session-start": 9000, "pre-compact": 4500, "session-end": 4500 };

const BUILDING_TEXT =
  "Reverie was just installed and is building itself in the background (a minute or two; it needs Node 22 or later and a network connection). If the memory_* tools are not listed yet, they will be in the next session, or after /mcp reconnects the server. There is no core block until then.";

/**
 * A plugin hook. Always exits 0, and stdout is the hook payload or nothing:
 * the CLI's stdout is passed on only when it exited cleanly.
 */
function hook(event) {
  if (!HOOK_EVENTS.includes(event)) return 0;

  if (built()) {
    const result = spawnSync(process.execPath, [join(root, "apps/reverie/dist/cli.js"), "hook", event], {
      stdio: ["inherit", "pipe", "ignore"],
      timeout: HOOK_TIMEOUT_MS[event],
      maxBuffer: 1024 * 1024,
    });
    if (result.status === 0 && result.stdout && result.stdout.length > 0) process.stdout.write(result.stdout);
    return 0;
  }

  // Not built yet: start the build where it will outlive this hook. Only the
  // session start says why the tools may not be there yet.
  if (!building()) {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "build"], {
      cwd: root,
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  }
  if (event === "session-start") {
    process.stdout.write(
      `${JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: BUILDING_TEXT } })}\n`,
    );
  }
  return 0;
}

const mode = process.argv[2] ?? "mcp";
try {
  if (mode === "mcp") {
    await mcp();
  } else if (mode === "hook") {
    process.exitCode = hook(process.argv[3]);
  } else if (mode === "build") {
    if (!built() && !build()) await waitForBuild(10 * 60_000);
    process.exitCode = built() ? 0 : 1;
  } else {
    process.stderr.write("Usage: plugin-bootstrap.mjs mcp | hook <session-start|pre-compact|session-end> | build\n");
    process.exitCode = 2;
  }
} catch (error) {
  process.stderr.write(`Reverie: ${error instanceof Error ? error.message : String(error)}\n`);
  // A hook never fails the session.
  process.exitCode = mode === "hook" ? 0 : 1;
}
