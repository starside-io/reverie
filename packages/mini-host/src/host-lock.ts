import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * One host at a time. docs/SPEC.md section 10, "Single writer and host.lock".
 *
 * The silo has one writer, so two `reverie serve` processes over the same
 * files is a bug waiting for a write. The host that serves takes host.lock,
 * beside host.db, and a second one refuses to start while the first is alive,
 * naming it. The lock also says how the live host was started, which is what
 * lets `reverie restart` bring it back the same way on new code.
 *
 * Lifted from Fellowship's host-lock.ts. As there, only `serve` takes the
 * lock: the stdio MCP server neither takes nor checks it.
 */

export const HOST_LOCK_FILE = "host.lock";

export interface HostLock {
  pid: number;
  /** Null while the host is still binding its socket. */
  port: number | null;
  url: string | null;
  fingerprint: string;
  startedAt: string;
  /** desktop when the desktop shell started it and owns its lifetime. */
  owner: "desktop" | "cli";
  /** How to start the same host again: node, its flags, the script and args. */
  execPath: string;
  execArgv: string[];
  argv: string[];
  cwd: string;
  /** The REVERIE_* variables it was started with. */
  env: Record<string, string>;
}

export class HostAlreadyRunning extends Error {
  readonly lock: HostLock;

  constructor(lock: HostLock) {
    super(
      `Reverie is already running${lock.url ? ` on ${lock.url}` : ""} (pid ${lock.pid}, started ${
        lock.startedAt
      }). One host at a time: stop it, or run \`reverie restart\`.`,
    );
    this.name = "HostAlreadyRunning";
    this.lock = lock;
  }
}

export function hostLockPath(hostDbPath: string): string {
  return join(dirname(hostDbPath), HOST_LOCK_FILE);
}

export function readHostLock(path: string): HostLock | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as HostLock;
  } catch {
    return null;
  }
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists, it just is not ours to signal.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The pid the host on this port says it is, or null when nothing answers. */
export async function healthPid(port: number): Promise<number | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    const body = (await response.json()) as { ok?: boolean; pid?: unknown };
    return body.ok === true && typeof body.pid === "number" ? body.pid : null;
  } catch {
    return null;
  }
}

/** A host still starting up gets this long to bind before its lock is stale. */
const STARTUP_GRACE_MS = 2 * 60_000;

/**
 * The lock when the host it names is really running, else null. A pid alone
 * is not proof, since the OS reuses them: the host on the recorded port has
 * to answer with that same pid.
 */
export async function liveHostLock(path: string): Promise<HostLock | null> {
  const lock = readHostLock(path);
  if (!lock || !processAlive(lock.pid)) return null;
  if (lock.port === null) {
    return Date.now() - Date.parse(lock.startedAt) < STARTUP_GRACE_MS ? lock : null;
  }
  return (await healthPid(lock.port)) === lock.pid ? lock : null;
}

function reverieEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] =>
        entry[0].startsWith("REVERIE_") && typeof entry[1] === "string",
    ),
  );
}

/** The env var a desktop shell sets so the host it starts exits with it. */
export const PARENT_PID_ENV = "REVERIE_PARENT_PID";

export function describeThisProcess(
  fingerprint: string,
  env: NodeJS.ProcessEnv = process.env,
): HostLock {
  return {
    pid: process.pid,
    port: null,
    url: null,
    fingerprint,
    startedAt: new Date().toISOString(),
    owner: env[PARENT_PID_ENV] ? "desktop" : "cli",
    execPath: process.execPath,
    execArgv: process.execArgv,
    argv: process.argv,
    cwd: process.cwd(),
    env: reverieEnv(env),
  };
}

/**
 * Takes the lock or throws HostAlreadyRunning. The file is created with wx, so
 * two hosts starting in the same instant cannot both win; a lock left by a
 * host that died is removed and taken.
 */
export async function acquireHostLock(path: string, lock: HostLock): Promise<void> {
  // On a first run the data folder does not exist yet: the lock is taken
  // before the files are opened, so it has to make the folder itself.
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, "wx");
      try {
        writeSync(fd, JSON.stringify(lock, null, 2));
      } finally {
        closeSync(fd);
      }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const live = await liveHostLock(path);
      // Fellowship lets this process take over a lock it already holds.
      // Reverie refuses that too: a second serve inside one process over the
      // same files is the same two writers, and nothing else would catch it.
      if (live) throw new HostAlreadyRunning(live);
      rmSync(path, { force: true });
    }
  }
  throw new Error(`Could not take ${path}`);
}

/** Records the port once the socket is bound. */
export function updateHostLock(path: string, patch: Partial<HostLock>): void {
  const current = readHostLock(path);
  if (!current || current.pid !== process.pid) return;
  writeFileSync(path, JSON.stringify({ ...current, ...patch }, null, 2));
}

/** Removes the lock, but only this process's own. */
export function releaseHostLock(path: string): void {
  const current = readHostLock(path);
  if (current && current.pid === process.pid) rmSync(path, { force: true });
}
