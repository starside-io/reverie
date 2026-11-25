import { homedir } from "node:os";
import { join } from "node:path";

/** The file name, with its two WAL sidecars. All three move together. */
export const DB_FILE_NAME = "reverie.db";

/** The env var that overrides the platform location, path to the file itself. */
export const DB_PATH_ENV = "REVERIE_DB_PATH";

/** The env var the Prisma datasource reads. Set from the resolved path. */
export const DB_URL_ENV = "REVERIE_DATABASE_URL";

/**
 * Where the silo lives on this machine.
 *
 *   macOS   ~/Library/Application Support/reverie/reverie.db
 *   Linux   ${XDG_DATA_HOME:-~/.local/share}/reverie/reverie.db
 *
 * REVERIE_DB_PATH overrides both, and points at the file rather than its
 * directory, so a test can hand over a throwaway path.
 */
export function resolveDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[DB_PATH_ENV]?.trim();
  if (override) return override;
  return join(resolveDataDir(env), DB_FILE_NAME);
}

/** The directory the file and its sidecars sit in. */
export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "reverie");
  }
  const xdg = env["XDG_DATA_HOME"]?.trim();
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".local", "share");
  return join(base, "reverie");
}

/**
 * The datasource URL for a path. One connection, because the silo has one
 * writer and that is a feature: it structurally prevents two sessions writing
 * to the same live file at once.
 */
export function dbUrl(path: string = resolveDbPath()): string {
  return `file:${path}?connection_limit=1`;
}
