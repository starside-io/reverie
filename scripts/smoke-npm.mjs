#!/usr/bin/env node
// Proves the npm package works where it will be used: outside this workspace,
// installed from its tarball, with no registry entry for it. docs/SPEC.md
// section 23, M9: "npx serves it".
//
//   node scripts/smoke-npm.mjs            pack (building first), then check
//   node scripts/smoke-npm.mjs --no-build pack from the dist folders as they are
//   node scripts/smoke-npm.mjs --keep     leave the temp folder for a look
//
// Everything happens in one temp folder: the project the tarball installs
// into, the silo and host.db (REVERIE_DB_PATH, REVERIE_HOST_DB_PATH), and an
// npm cache of its own. The only network use is npm fetching the package's
// declared dependencies on the first install; the npx run after it is
// --offline from that same cache. It checks:
//
//   reverie tools      lists 41 tools
//   reverie eval       scores the corpus the package carries
//   reverie serve      on a free port other than 4329 answers /health and serves the UI
//   reverie mcp        answers initialize and tools/list over stdio, with 41 tools
//   npx reverie status through npx --package <tarball>, offline
//
// The server is stopped by the pid listening on its port, with a plain
// SIGTERM, after checking that pid is the one this script started.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packDir = join(root, ".npm-package");
const keep = process.argv.includes("--keep");
const TOOLS = 41;
const DEFAULT_PORT = 4329;
const realSilo = join(homedir(), "Library", "Application Support", "reverie");
const realSiloBefore = existsSync(realSilo);

function log(line) {
  process.stdout.write(`${line}\n`);
}

function check(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  log(`ok   ${message}`);
}

// 1. The tarball.
execFileSync(process.execPath, [join(root, "scripts", "pack-npm.mjs"), ...(process.argv.includes("--no-build") ? ["--no-build"] : [])], {
  cwd: root,
  stdio: "inherit",
});
const tarballName = readdirSync(packDir).find((entry) => entry.endsWith(".tgz"));
if (!tarballName) throw new Error(`No tarball in ${packDir}`);
const tarball = join(packDir, tarballName);

// 2. A temp folder outside the workspace, and the env every command runs in.
const temp = mkdtempSync(join(tmpdir(), "reverie-npm-smoke-"));
const project = join(temp, "project");
const elsewhere = join(temp, "elsewhere");
const silo = join(temp, "silo");
for (const dir of [project, elsewhere, silo]) mkdirSync(dir, { recursive: true });
const env = {
  ...process.env,
  REVERIE_DB_PATH: join(silo, "reverie.db"),
  REVERIE_HOST_DB_PATH: join(silo, "host.db"),
  npm_config_cache: join(temp, "npm-cache"),
  npm_config_update_notifier: "false",
  npm_config_fund: "false",
  npm_config_audit: "false",
};
delete env["CLAUDE_CODE_SESSION_ID"];
delete env["REVERIE_PORT"];
delete env["REVERIE_UI_DIR"];

let server = null;

async function freePort() {
  for (;;) {
    const port = await new Promise((done, fail) => {
      const probe = createServer();
      probe.once("error", fail);
      probe.listen(0, "127.0.0.1", () => {
        const address = probe.address();
        probe.close(() => done(typeof address === "object" && address ? address.port : 0));
      });
    });
    if (port !== DEFAULT_PORT && port > 0) return port;
  }
}

async function waitFor(fn, ms, what) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const value = await fn().catch(() => null);
    if (value) return value;
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

function listenerPid(port) {
  try {
    const out = execFileSync("lsof", ["-t", `-iTCP:${port}`, "-sTCP:LISTEN", "-n", "-P"], { encoding: "utf8" });
    return out.split("\n").map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function mcpSession(bin) {
  return new Promise((done, fail) => {
    const child = spawn(bin, ["mcp"], { cwd: elsewhere, env, stdio: ["pipe", "pipe", "pipe"] });
    let buffer = "";
    const answers = new Map();
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      fail(new Error("The MCP server did not answer within 60 seconds"));
    }, 60_000);
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        if (message.id !== undefined) answers.set(message.id, message);
        if (message.id === 1) {
          child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
          child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
        }
        if (message.id === 2) {
          clearTimeout(timer);
          child.stdin.end();
          child.kill("SIGTERM");
          done({ initialize: answers.get(1), list: message });
        }
      }
    });
    child.on("error", fail);
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0.0.0" } },
      })}\n`,
    );
  });
}

try {
  log(`\ntemp        ${temp}`);
  log(`tarball     ${tarball}`);

  // 3. Install it into a fresh project, as anyone would from the registry.
  writeFileSync(join(project, "package.json"), `${JSON.stringify({ name: "reverie-smoke", version: "0.0.0", private: true }, null, 2)}\n`);
  execFileSync("npm", ["install", tarball, "--no-audit", "--no-fund"], { cwd: project, env, stdio: "inherit" });
  const bin = join(project, "node_modules", ".bin", "reverie");
  check(existsSync(bin), "the reverie bin is installed");
  check(
    existsSync(join(project, "node_modules", "@starside", "reverie", "node_modules", "@reverie", "core", "generated", "prisma", "index.js")),
    "postinstall generated the Prisma client for this machine",
  );

  // 4. reverie tools
  const tools = execFileSync(bin, ["tools"], { cwd: elsewhere, env, encoding: "utf8" });
  const toolLines = tools.split("\n").filter((line) => /^\S+\s+memory\./.test(line));
  check(toolLines.length === TOOLS, `reverie tools lists ${toolLines.length} tools`);

  // reverie eval reads the corpus the package carries, in a throwaway silo of its own.
  const evalOut = execFileSync(bin, ["eval"], { cwd: elsewhere, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  check(/recall@1|R@1|abstention/i.test(evalOut), "reverie eval scores the packaged corpus");

  // 5. reverie serve
  const port = await freePort();
  server = spawn(bin, ["serve", "--port", String(port)], { cwd: elsewhere, env, stdio: ["ignore", "pipe", "pipe"] });
  let serverOut = "";
  server.stdout.on("data", (chunk) => (serverOut += chunk));
  server.stderr.on("data", (chunk) => (serverOut += chunk));
  const health = await waitFor(
    async () => {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      return response.ok ? response.json() : null;
    },
    60_000,
    "/health",
  );
  check(health.ok === true && health.tools === TOOLS, `reverie serve on ${port} answers /health with ${health.tools} tools`);
  check(health.silo === env.REVERIE_DB_PATH, "the host opened the throwaway silo");
  const page = await fetch(`http://127.0.0.1:${port}/`, { headers: { accept: "text/html" } });
  const html = await page.text();
  check(page.ok && /<div id="root">/.test(html), "reverie serve hands out the built UI index");

  const pids = listenerPid(port);
  log(`     lsof -iTCP:${port} -sTCP:LISTEN: pid ${pids.join(", ") || "none"}`);
  check(pids.length === 1 && pids[0] === String(server.pid), `the listener is the server this script started (pid ${server.pid})`);
  process.kill(Number(pids[0]), "SIGTERM");
  await waitFor(async () => server.exitCode !== null || server.signalCode !== null, 15_000, "the server to stop");
  check(listenerPid(port).length === 0, "the server stopped and the port is free");
  server = null;

  // 6. reverie mcp
  const mcp = await mcpSession(bin);
  check(mcp.initialize?.result?.serverInfo !== undefined, `reverie mcp answers initialize (${mcp.initialize.result.serverInfo.name} ${mcp.initialize.result.serverInfo.version})`);
  check(mcp.list?.result?.tools?.length === TOOLS, `reverie mcp lists ${mcp.list.result.tools.length} tools over stdio`);

  // 7. The npx path, offline, from the cache the install filled.
  const status = execFileSync("npx", ["--offline", "--yes", "--package", tarball, "reverie", "status"], {
    cwd: elsewhere,
    env,
    encoding: "utf8",
  });
  log(status.trimEnd().split("\n").map((line) => `     ${line}`).join("\n"));
  check(new RegExp(`tools\\s+${TOOLS}`).test(status), "npx --package <tarball> reverie status runs offline");
  check(status.includes(env.REVERIE_DB_PATH), "npx used the throwaway silo");

  check(existsSync(realSilo) === realSiloBefore, "the default silo folder was not created");
  log("\nThe npm package works from its tarball.");
} finally {
  if (server && server.exitCode === null) server.kill("SIGTERM");
  if (keep) log(`kept ${temp}`);
  else rmSync(temp, { recursive: true, force: true });
}
