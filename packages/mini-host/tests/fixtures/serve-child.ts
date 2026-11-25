import { serveMiniHost } from "../../src/server.js";

/**
 * A second host in its own process, over the files REVERIE_DB_PATH and
 * REVERIE_HOST_DB_PATH name: what another `reverie serve` looks like from a
 * test. Prints its port once it listens, and stops on SIGTERM.
 */
const running = await serveMiniHost({ port: 0 });
process.stdout.write(`${JSON.stringify({ pid: process.pid, port: running.port })}\n`);
process.on("SIGTERM", () => {
  void running.close().then(() => process.exit(0));
});
