import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The package root: tsx reads tsconfig.json from there to map @reverie/core to source. */
export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const started: ChildProcess[] = [];

/** A TypeScript file run in its own Node process, through tsx. */
export function spawnTs(file: string, env: NodeJS.ProcessEnv): ChildProcess {
  const child = spawn(process.execPath, ["--import", "tsx", file], {
    cwd: PACKAGE_ROOT,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  started.push(child);
  return child;
}

/** The first line a child writes to stdout, parsed. */
export function firstLine<T>(child: ChildProcess): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let buffer = "";
    let errors = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      errors += chunk.toString();
    });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`The child exited (${code}) before it spoke: ${errors}`)));
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline >= 0) resolve(JSON.parse(buffer.slice(0, newline)) as T);
    });
  });
}

/** Stops every child this file started, by handle, never by name or port. */
export async function stopChildren(): Promise<void> {
  for (const child of started.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGTERM");
      await exited;
    }
  }
}
