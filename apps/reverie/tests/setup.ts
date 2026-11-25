import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A safety net under every test in this package: should anything resolve the
 * silo or host.db from the environment rather than from the paths a test
 * hands over, it lands in a throwaway directory, never in the real one.
 */
const dir = mkdtempSync(join(tmpdir(), "reverie-env-"));
process.env["REVERIE_DB_PATH"] = join(dir, "reverie.db");
process.env["REVERIE_HOST_DB_PATH"] = join(dir, "host.db");

// Run inside a Claude Code session, the test process inherits that session's
// id. The servers and hooks these tests start must not pick it up: each test
// says which session it is in.
delete process.env["CLAUDE_CODE_SESSION_ID"];
