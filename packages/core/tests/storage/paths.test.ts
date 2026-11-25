import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { DB_FILE_NAME, dbUrl, resolveDataDir, resolveDbPath } from "../../src/storage/paths.js";

describe("resolveDbPath", () => {
  it("honours REVERIE_DB_PATH over the platform location", () => {
    expect(resolveDbPath({ REVERIE_DB_PATH: "/tmp/elsewhere/reverie.db" })).toBe(
      "/tmp/elsewhere/reverie.db",
    );
  });

  it("ignores an empty override", () => {
    expect(resolveDbPath({ REVERIE_DB_PATH: "  " })).toBe(join(resolveDataDir({}), DB_FILE_NAME));
  });

  it("uses the platform data directory", () => {
    const expected =
      process.platform === "darwin"
        ? join(homedir(), "Library", "Application Support", "reverie")
        : join(homedir(), ".local", "share", "reverie");
    expect(resolveDataDir({})).toBe(expected);
  });

  it("follows XDG_DATA_HOME off macOS", () => {
    const resolved = resolveDataDir({ XDG_DATA_HOME: "/data" });
    if (process.platform === "darwin") {
      expect(resolved).toBe(join(homedir(), "Library", "Application Support", "reverie"));
    } else {
      expect(resolved).toBe(join("/data", "reverie"));
    }
  });
});

describe("dbUrl", () => {
  it("pins the connection limit to one writer", () => {
    expect(dbUrl("/tmp/a.db")).toBe("file:/tmp/a.db?connection_limit=1");
  });
});
