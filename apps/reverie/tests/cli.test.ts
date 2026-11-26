import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";

import { hostLockPath, liveHostLock, processAlive, serveMiniHost, startMiniHost } from "@reverie/mini-host";

import { USAGE, run, type Io } from "../src/main.js";

/**
 * The binary, command by command, against a throwaway pair of files. Most
 * commands run in this process through run(); serve, restart and mcp run as
 * real processes, because they keep one up. Every name is invented.
 */

const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

interface Captured extends Io {
  stdout: string;
  stderr: string;
  dir: string;
}

function throwawayIo(dir: string = mkdtempSync(join(tmpdir(), "reverie-cli-"))): Captured {
  const io: Captured = {
    dir,
    stdout: "",
    stderr: "",
    env: {
      ...process.env,
      REVERIE_DB_PATH: join(dir, "reverie.db"),
      REVERIE_HOST_DB_PATH: join(dir, "host.db"),
    },
    cwd: dir,
    out: (text) => {
      io.stdout += text;
    },
    err: (text) => {
      io.stderr += text;
    },
  };
  return io;
}

async function seed(io: Captured): Promise<string> {
  const host = await startMiniHost({ env: io.env });
  try {
    const made = (await host.api.invoke("memory.remember", {
      kind: "fact",
      shelf: "LIF/HOM",
      body: "The spare key hangs by the back door of the cottage in Elmwood.",
    })) as { memory: { call: string } };
    await host.api.invoke("memory.remember", { kind: "fact", shelf: "LIF/HOM", body: "Prefers oat milk in coffee." });
    return made.memory.call;
  } finally {
    await host.close();
  }
}

const children: ChildProcess[] = [];

function spawnCli(args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: APP_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  return child;
}

function waitFor(child: ChildProcess, pattern: RegExp): Promise<string> {
  return new Promise((resolve, reject) => {
    let seen = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      seen += chunk.toString();
      if (pattern.test(seen)) resolve(seen);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      seen += chunk.toString();
    });
    child.once("exit", (code) => reject(new Error(`exited ${code}: ${seen}`)));
  });
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** Stops a pid this test started, by its exact pid, and waits for it. */
async function stopPid(pid: number): Promise<void> {
  if (!processAlive(pid)) return;
  process.kill(pid, "SIGTERM");
  const by = Date.now() + 10_000;
  while (processAlive(pid) && Date.now() < by) await new Promise((done) => setTimeout(done, 100));
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) await stopPid(child.pid);
  }
});

describe("reverie help and tools", () => {
  it("prints the usage, naming every command, with no dashes of the wrong kind", async () => {
    const io = throwawayIo();
    expect(await run(["help"], io)).toBe(0);
    for (const command of ["serve", "restart", "mcp", "status", "tools", "verify", "import", "export", "reindex", "dream"]) {
      expect(io.stdout).toContain(`  ${command}`);
    }
    expect(USAGE).not.toMatch(/[\u2013\u2014]/);

    const unknown = throwawayIo();
    expect(await run(["nope"], unknown)).toBe(2);
    expect(unknown.stderr).toContain('Unknown command "nope"');
  });

  it("lists the 41 tools, one line each", async () => {
    const io = throwawayIo();
    expect(await run(["tools"], io)).toBe(0);
    const lines = io.stdout.trim().split("\n");
    expect(lines).toHaveLength(41);
    expect(lines.filter((line) => line.startsWith("needs-ok"))).toHaveLength(6);
    expect(io.stdout).toContain("memory.recall");
  });
});

describe("reverie status", () => {
  it("says where the files are and what is in them", async () => {
    const io = throwawayIo();
    await seed(io);
    expect(await run(["status"], io)).toBe(0);
    expect(io.stdout).toContain(`silo        ${join(io.dir, "reverie.db")}`);
    expect(io.stdout).toContain(`host.db     ${join(io.dir, "host.db")}`);
    expect(io.stdout).toContain("host        not running");
    expect(io.stdout).toContain("memories    2 active");
    expect(io.stdout).toContain("full text only");
  });
});

describe("reverie export, verify and import", () => {
  it("exports a snapshot that verifies, and merges it back after taking a backup", async () => {
    const io = throwawayIo();
    await seed(io);

    expect(await run(["export", "library.snapshot.json"], io)).toBe(0);
    const file = join(io.dir, "library.snapshot.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ version: 1 });
    expect(io.stdout).toContain("2 memories");

    const verify = throwawayIo(io.dir);
    expect(await run(["verify", file], verify)).toBe(0);
    expect(verify.stdout).toContain("No data loss.");

    const merge = throwawayIo(io.dir);
    expect(await run(["import", file], merge)).toBe(0);
    const backups = readdirSync(join(io.dir, "backups"));
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(/^reverie-before-import-.*\.db$/);
    expect(merge.stdout).toContain(`Backed up the silo to ${join(io.dir, "backups", backups[0]!)}`);
    expect(merge.stdout).toContain("merge into");

    // The backup is a real silo with the library in it.
    const copy = await startMiniHost({ dbPath: join(io.dir, "backups", backups[0]!), hostDbPath: join(io.dir, "copy-host.db") });
    try {
      expect(await copy.silo.memory.count()).toBe(2);
    } finally {
      await copy.close();
    }
  });

  it("refuses a replace without --yes, naming what it would destroy, and writes nothing", async () => {
    const io = throwawayIo();
    await seed(io);
    await run(["export", "library.snapshot.json"], io);

    const replace = throwawayIo(io.dir);
    expect(await run(["import", "library.snapshot.json", "--replace"], replace)).toBe(1);
    expect(replace.stdout).toContain("This will destroy everything in");
    expect(replace.stdout).toMatch(/memories\s+2/);
    expect(replace.stderr).toContain("Refusing a replace without --yes");
    expect(existsSync(join(io.dir, "backups"))).toBe(false);
  });

  it("replaces with --yes through the dry run's acknowledgement, after a backup", async () => {
    const io = throwawayIo();
    const call = await seed(io);
    await run(["export", "library.snapshot.json"], io);

    // A memory written after the export: the replace takes the library back to the file.
    const host = await startMiniHost({ env: io.env });
    try {
      await host.api.invoke("memory.remember", { kind: "fact", shelf: "LIF/HOM", body: "The bike pump lives in the hall cupboard." });
    } finally {
      await host.close();
    }

    const replace = throwawayIo(io.dir);
    expect(await run(["import", "library.snapshot.json", "--replace", "--yes"], replace)).toBe(0);
    expect(replace.stdout).toMatch(/memories\s+3/);
    expect(replace.stdout).toContain("replace into");
    expect(readdirSync(join(io.dir, "backups"))).toHaveLength(1);

    const after = await startMiniHost({ env: io.env });
    try {
      expect(await after.silo.memory.count()).toBe(2);
      expect(await after.silo.memory.findUnique({ where: { callNumber: call } })).not.toBeNull();
      // The tool was called with the acknowledgement, never around it.
      const imports = after.store.listAudit(100).filter((entry) => entry.tool === "memory.import");
      expect(imports).toHaveLength(2);
      expect(imports.every((entry) => !(entry.detail as { refused?: string } | null)?.refused)).toBe(true);
    } finally {
      await after.close();
    }
  });
});

describe("reverie export and import through a folder", () => {
  it("writes a mirror folder and reads it into another silo, then reports an edit file by file", async () => {
    const io = throwawayIo();
    await seed(io);
    expect(await run(["export", "mirror", "--mirror"], io)).toBe(0);
    expect(io.stdout).toContain("2 memories in 3 files");
    expect(existsSync(join(io.dir, "mirror", ".reverie", "library.json"))).toBe(true);
    expect(readdirSync(join(io.dir, "mirror", "Life", "Home"))).toHaveLength(2);

    // An existing folder is a mirror without the flag; writing it again changes nothing.
    const again = throwawayIo(io.dir);
    expect(await run(["export", "mirror"], again)).toBe(0);
    expect(again.stdout).toMatch(/written\s+0/);

    const other = throwawayIo();
    const into = { ...other, cwd: io.dir };
    expect(await run(["import", "mirror", "--dry-run"], into)).toBe(0);
    expect(other.stdout).toContain("Nothing was written.");
    expect(existsSync(join(other.dir, "backups"))).toBe(false);
    expect(await run(["import", "mirror"], into)).toBe(0);
    expect(other.stdout).toMatch(/memories\s+2/);
    expect(other.stdout).toContain(`Backed up the silo to ${join(other.dir, "backups")}`);

    const host = await startMiniHost({ env: other.env });
    try {
      expect(await host.silo.memory.count()).toBe(2);
    } finally {
      await host.close();
    }
  });

  it("imports a Claude Code memory directory once, into a project, and never writes to it", async () => {
    const { writeClaudeCodeFixture } = await import("../../../packages/adapter-markdown/tests/fixtures/claude-code.js");
    const io = throwawayIo();
    const dir = writeClaudeCodeFixture(join(io.dir, "claude-memory"));
    const before = readdirSync(dir).map((name) => readFileSync(join(dir, name), "utf8"));
    const host = await startMiniHost({ env: io.env });
    try {
      await host.api.invoke("memory.set_projects", { action: "create", slug: "harbour", name: "Harbour" });
    } finally {
      await host.close();
    }

    expect(await run(["import", "claude-memory", "--project", "harbour"], io)).toBe(0);
    expect(io.stdout).toMatch(/memories\s+5/);
    expect(io.stdout).toMatch(/links\s+1/);
    const second = throwawayIo(io.dir);
    expect(await run(["import", "claude-memory", "--claude-code", "--project", "harbour"], second)).toBe(0);
    expect(second.stdout).toMatch(/memories\s+0/);
    expect(readdirSync(dir).map((name) => readFileSync(join(dir, name), "utf8"))).toEqual(before);
  });
});

describe("reverie reindex and dream", () => {
  it("rebuilds the search index and checks it", async () => {
    const io = throwawayIo();
    await seed(io);
    expect(await run(["reindex"], io)).toBe(0);
    expect(io.stdout).toContain("memories  2");
    expect(io.stdout).toContain("matches its rows");
  });

  it("says whether consolidation is due and what an assistant runs, and runs no pass", async () => {
    const io = throwawayIo();
    await seed(io);
    expect(await run(["dream"], io)).toBe(0);
    expect(io.stdout).toContain("consolidation  not due");
    expect(io.stdout).toContain("last run     never");
    expect(io.stdout).toContain("/reverie:dream");

    // Ten ended sessions make it due, by consolidateEvery.sessions.
    const host = await startMiniHost({ env: io.env });
    try {
      for (let index = 1; index <= 10; index += 1) {
        await host.publish("host.session.ended", { sessionId: `session-${index}` });
      }
      expect(host.store.listProposals("all")).toHaveLength(0);
    } finally {
      await host.close();
    }
    const due = throwawayIo(io.dir);
    expect(await run(["dream"], due)).toBe(0);
    expect(due.stdout).toContain("consolidation  due");
    expect(due.stdout).toContain("ready to extract  10 sessions");
  });
});

describe("reverie serve and restart", () => {
  it("refuses a second host over the same files, naming the first", async () => {
    const io = throwawayIo();
    const first = await serveMiniHost({ env: io.env, port: 0 });
    try {
      expect(await run(["serve", "--port", "0"], io)).toBe(3);
      expect(io.stderr).toContain(`pid ${process.pid}`);
      expect(io.stderr).toContain(first.url);
    } finally {
      await first.close();
    }
  });

  it("restarts a running host the way it was started", async () => {
    const io = throwawayIo();
    const port = await freePort();
    const child = spawnCli(["serve", "--port", String(port)], io.env);
    await waitFor(child, /Reverie is up on/);
    const lockPath = hostLockPath(join(io.dir, "host.db"));
    expect(await liveHostLock(lockPath)).toMatchObject({ pid: child.pid, port });

    const status = throwawayIo(io.dir);
    await run(["status"], status);
    expect(status.stdout).toContain(`running on http://127.0.0.1:${port} (pid ${child.pid})`);

    const restart = throwawayIo(io.dir);
    expect(await run(["restart"], restart)).toBe(0);
    const live = await liveHostLock(lockPath);
    try {
      expect(live).not.toBeNull();
      expect(live!.pid).not.toBe(child.pid);
      expect(live!.port).toBe(port);
      expect(restart.stdout).toContain(`Restarted on http://127.0.0.1:${port} (pid ${live!.pid})`);
    } finally {
      if (live) await stopPid(live.pid);
    }
  });

  it("with nothing running, restart has nothing to do", async () => {
    const io = throwawayIo();
    expect(await run(["restart"], io)).toBe(0);
    expect(io.stdout).toContain("No host is running");
  });
});

describe("reverie mcp", () => {
  it("serves the 41 tools over stdio", async () => {
    const io = throwawayIo();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "src/cli.ts", "mcp"],
      cwd: APP_ROOT,
      env: io.env as Record<string, string>,
      stderr: "pipe",
    });
    const client = new Client({ name: "test-assistant", version: "0.0.1" });
    await client.connect(transport);
    try {
      expect((await client.listTools()).tools).toHaveLength(41);
    } finally {
      await client.close();
    }
  });
});

describe("the files these tests write", () => {
  it("are all in throwaway directories", () => {
    const io = throwawayIo();
    expect(io.env["REVERIE_DB_PATH"]?.startsWith(tmpdir())).toBe(true);
    writeFileSync(join(io.dir, "probe"), "");
    expect(existsSync(join(io.dir, "probe"))).toBe(true);
  });
});
