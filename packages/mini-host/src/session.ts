import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import type { SessionInfo } from "@reverie/core";

/**
 * Where an assistant attached over stdio is working, read once when the
 * server starts. Core uses it to resolve the project (docs/SPEC.md section 4)
 * and to scope session and agent memories.
 *
 *   folder     the server's working directory, which is the session's
 *   gitRemote  `git remote get-url origin` in that folder, when git answers
 *              within a moment; null otherwise. Core normalises it.
 *   id         REVERIE_SESSION_ID, else CLAUDE_CODE_SESSION_ID, else a fresh
 *              id per server process: an MCP client starts one server per
 *              session, so one process is one session
 *   agent      REVERIE_AGENT, else null. Section 24 leaves naming an agent to
 *              the caller, so nothing is guessed from the client's name.
 */

export const SESSION_ID_ENV = "REVERIE_SESSION_ID";
export const AGENT_ENV = "REVERIE_AGENT";

/**
 * The session id Claude Code sets for the processes it starts: Bash and hook
 * commands, and stdio MCP servers. Documented in Claude Code's environment
 * variable reference. It is what lines a session note written over MCP up
 * with the SessionEnd hook that marks the session ready for extraction: the
 * hook reads the same id as `session_id` on its stdin. Two sessions in one
 * folder each start their own server, so each server carries its own id.
 *
 * The limits, as that reference states them, and why this is not exact:
 *
 * - An MCP server keeps the id it was spawned with. After /clear, Claude
 *   Code starts a new session id for hooks and Bash, but this server still
 *   carries the old one, so notes written after /clear are filed under the
 *   session that /clear ended (whose SessionEnd already marked it ready),
 *   and the new session's own SessionEnd marks an id that holds no notes.
 * - On --continue, or --resume without an explicit id, the server may get
 *   the startup id rather than the resumed one.
 * - With CLAUDE_CODE_MCP_ALLOWLIST_ENV=1 the server gets a reduced
 *   environment; if the id is not in it, a fresh id is used and notes do not
 *   line up with the hook at all.
 *
 * Outside Claude Code the variable is absent and nothing changes.
 */
export const CLAUDE_SESSION_ID_ENV = "CLAUDE_CODE_SESSION_ID";

/** The remote of a folder, or null when there is none or git is slow or absent. */
export function gitRemoteOf(folder: string): string | null {
  try {
    const out = execFileSync("git", ["-C", folder, "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1500,
    }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

export function sessionFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): SessionInfo {
  return {
    id: env[SESSION_ID_ENV]?.trim() || env[CLAUDE_SESSION_ID_ENV]?.trim() || randomUUID(),
    folder: cwd,
    gitRemote: gitRemoteOf(cwd),
    agent: env[AGENT_ENV]?.trim() || null,
  };
}
