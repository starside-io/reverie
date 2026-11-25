import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  HostAlreadyRunning,
  acquireHostLock,
  describeThisProcess,
  hostLockPath,
  liveHostLock,
  processAlive,
  readHostLock,
  releaseHostLock,
  type HostLock,
} from "../src/host-lock.js";
import { serveMiniHost } from "../src/server.js";
import { firstLine, spawnTs, stopChildren } from "./fixtures/children.js";
import { envFor, filesIn, throwawayDir } from "./harness.js";

/**
 * One host at a time. The lock sits beside host.db in a throwaway directory
 * here, never beside the real one. Lifted from Fellowship's
 * host-lock.test.ts, with a real second host process added.
 */

function lockFor(pid: number, overrides: Partial<HostLock> = {}): HostLock {
  return { ...describeThisProcess("test-fingerprint"), pid, ...overrides };
}

function writeLock(path: string, lock: HostLock): void {
  writeFileSync(path, JSON.stringify(lock, null, 2));
}

/** A pid that was real a moment ago and is not any more. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid;
  if (pid === undefined) throw new Error("The child did not start");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  return pid;
}

const children: ChildProcess[] = [];

/**
 * Another live process that answers /health with its own pid, which is what
 * a second host process holding the lock looks like from here.
 */
async function otherHost(): Promise<{ pid: number; port: number }> {
  const script = `
    const http = require("node:http");
    const server = http.createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, pid: process.pid }));
    });
    server.listen(0, "127.0.0.1", () => {
      process.stdout.write(String(server.address().port) + "\\n");
    });
  `;
  const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "inherit"] });
  children.push(child);
  const port = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.stdout!.once("data", (chunk: Buffer) => resolve(Number(chunk.toString().trim())));
  });
  return { pid: child.pid!, port };
}

afterEach(async () => {
  // Only the children this file spawned, by handle.
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill();
      await exited;
    }
  }
  await stopChildren();
});

describe("acquireHostLock", () => {
  it("writes the lock on an empty directory", async () => {
    const path = hostLockPath(join(throwawayDir(), "host.db"));
    expect(existsSync(path)).toBe(false);

    const lock = describeThisProcess("abc123");
    await acquireHostLock(path, lock);

    expect(readHostLock(path)).toEqual(lock);
    expect(readHostLock(path)).toMatchObject({ pid: process.pid, port: null, url: null });
    releaseHostLock(path);
  });

  it("records how the host was started, with only the REVERIE_ variables", () => {
    const lock = describeThisProcess("abc123", { REVERIE_PORT: "4400", HOME: "/home/jane", PATH: "/bin" });
    expect(lock.env).toEqual({ REVERIE_PORT: "4400" });
    expect(lock.owner).toBe("cli");
    expect(lock.execPath).toBe(process.execPath);
    expect(lock.argv).toEqual(process.argv);
    expect(describeThisProcess("abc123", { REVERIE_PARENT_PID: "42" }).owner).toBe("desktop");
  });

  it("replaces a lock left by a process that died", async () => {
    const path = hostLockPath(join(throwawayDir(), "host.db"));
    const pid = await deadPid();
    expect(processAlive(pid)).toBe(false);
    writeLock(path, lockFor(pid, { port: 1, url: "http://127.0.0.1:1" }));

    await acquireHostLock(path, describeThisProcess("fresh"));

    expect(readHostLock(path)).toMatchObject({ pid: process.pid, fingerprint: "fresh" });
    releaseHostLock(path);
  });

  it("replaces a lock whose port answers with another pid", async () => {
    // The pid is alive, but nothing on its recorded port says it is that pid.
    const other = await otherHost();
    const path = hostLockPath(join(throwawayDir(), "host.db"));
    writeLock(path, lockFor(process.ppid, { port: other.port }));

    await acquireHostLock(path, describeThisProcess("fresh"));

    expect(readHostLock(path)).toMatchObject({ pid: process.pid });
    releaseHostLock(path);
  });

  it("refuses while another live host holds it, and names it", async () => {
    const other = await otherHost();
    const path = hostLockPath(join(throwawayDir(), "host.db"));
    writeLock(path, lockFor(other.pid, { port: other.port, url: `http://127.0.0.1:${other.port}` }));

    const attempt = acquireHostLock(path, describeThisProcess("second"));
    await expect(attempt).rejects.toBeInstanceOf(HostAlreadyRunning);
    await expect(attempt).rejects.toMatchObject({ lock: { pid: other.pid } });
    await expect(attempt).rejects.toThrow(new RegExp(`pid ${other.pid}`));
    await expect(attempt).rejects.toThrow(`http://127.0.0.1:${other.port}`);
    expect(readHostLock(path)).toMatchObject({ pid: other.pid });
  });

  it("refuses while another live host is still binding its port", async () => {
    const other = await otherHost();
    const path = hostLockPath(join(throwawayDir(), "host.db"));
    writeLock(path, lockFor(other.pid, { port: null, startedAt: new Date().toISOString() }));

    await expect(acquireHostLock(path, describeThisProcess("second"))).rejects.toBeInstanceOf(
      HostAlreadyRunning,
    );
  });
});

describe("releaseHostLock", () => {
  it("removes this process's own lock", async () => {
    const path = hostLockPath(join(throwawayDir(), "host.db"));
    await acquireHostLock(path, describeThisProcess("mine"));
    releaseHostLock(path);
    expect(existsSync(path)).toBe(false);
  });

  it("leaves another pid's lock alone", () => {
    const path = hostLockPath(join(throwawayDir(), "host.db"));
    writeLock(path, lockFor(process.ppid));
    releaseHostLock(path);
    expect(readHostLock(path)).toMatchObject({ pid: process.ppid });
  });

  it("does nothing when there is no lock", () => {
    const path = hostLockPath(join(throwawayDir(), "host.db"));
    expect(() => releaseHostLock(path)).not.toThrow();
  });
});

describe("serveMiniHost and the lock", () => {
  it("takes the lock, records the port, and releases it on close", async () => {
    const files = filesIn(throwawayDir());
    const path = hostLockPath(files.hostDbPath);

    const running = await serveMiniHost({ ...files, port: 0 });
    try {
      expect(readHostLock(path)).toMatchObject({
        pid: process.pid,
        port: running.port,
        url: running.url,
      });
      expect(await liveHostLock(path)).toMatchObject({ pid: process.pid });
    } finally {
      await running.close();
    }
    expect(existsSync(path)).toBe(false);
  });

  it("refuses to start beside another live host, and leaves its files alone", async () => {
    const other = await otherHost();
    const files = filesIn(throwawayDir());
    const path = hostLockPath(files.hostDbPath);
    writeLock(path, lockFor(other.pid, { port: other.port }));

    await expect(serveMiniHost({ ...files, port: 0 })).rejects.toBeInstanceOf(HostAlreadyRunning);
    // Refused before the files were opened.
    expect(existsSync(files.dbPath)).toBe(false);
    expect(existsSync(files.hostDbPath)).toBe(false);
    expect(readHostLock(path)).toMatchObject({ pid: other.pid });
  });

  it("starts over a lock left by a host that died", async () => {
    const files = filesIn(throwawayDir());
    const path = hostLockPath(files.hostDbPath);
    writeLock(path, lockFor(await deadPid(), { port: 1 }));

    const running = await serveMiniHost({ ...files, port: 0 });
    try {
      expect(readHostLock(path)).toMatchObject({ pid: process.pid, port: running.port });
    } finally {
      await running.close();
    }
  });

  it("answers /health with this pid and a fingerprint", async () => {
    const running = await serveMiniHost({ ...filesIn(throwawayDir()), port: 0 });
    try {
      const response = await fetch(`http://127.0.0.1:${running.port}/health`);
      const body = (await response.json()) as { ok: boolean; pid: number; fingerprint: unknown };
      expect(body.ok).toBe(true);
      expect(body.pid).toBe(process.pid);
      expect(body.fingerprint).toMatch(/^[0-9a-f]{16}$/);
      expect(readHostLock(hostLockPath(running.host.hostPath))?.fingerprint).toBe(body.fingerprint);
    } finally {
      await running.close();
    }
  });
});

describe("two hosts over the same files", () => {
  it("cannot both hold the lock inside one process", async () => {
    const files = filesIn(throwawayDir());
    const first = await serveMiniHost({ ...files, port: 0 });
    try {
      await expect(serveMiniHost({ ...files, port: 0 })).rejects.toBeInstanceOf(HostAlreadyRunning);
      // The first one still holds it, and still answers.
      expect(readHostLock(hostLockPath(files.hostDbPath))).toMatchObject({ pid: process.pid, port: first.port });
      expect((await fetch(`${first.url}/health`)).status).toBe(200);
    } finally {
      await first.close();
    }
  });

  it("cannot both hold the lock from two processes: the second is refused, naming the first", async () => {
    const dir = throwawayDir();
    const files = filesIn(dir);
    const child = spawnTs("tests/fixtures/serve-child.ts", envFor(dir));
    const first = await firstLine<{ pid: number; port: number }>(child);

    const attempt = serveMiniHost({ ...files, port: 0 });
    await expect(attempt).rejects.toBeInstanceOf(HostAlreadyRunning);
    await expect(attempt).rejects.toThrow(`pid ${first.pid}`);
    await expect(attempt).rejects.toThrow(`http://127.0.0.1:${first.port}`);
    expect(readHostLock(hostLockPath(files.hostDbPath))).toMatchObject({ pid: first.pid, port: first.port });

    // Once the first one stops, its lock goes with it and the second starts.
    await stopChildren();
    expect(existsSync(hostLockPath(files.hostDbPath))).toBe(false);
    const second = await serveMiniHost({ ...files, port: 0 });
    await second.close();
  });
});
