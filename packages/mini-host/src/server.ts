import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";

import { surfaceFingerprint, tools as coreTools } from "@reverie/core";

import { resolveHostDbPath } from "./host-db.js";
import { startMiniHost, type MiniHost, type MiniHostOptions } from "./host.js";
import {
  acquireHostLock,
  describeThisProcess,
  hostLockPath,
  releaseHostLock,
  updateHostLock,
} from "./host-lock.js";
import { desktopAppStatus, installDesktopApp, type AppInstallSeams } from "./desktop-app.js";
import { ownerGuard } from "./guard.js";
import { rpcRoutes } from "./rpc.js";
import {
  UPDATES_SETTING,
  checkForUpdates,
  installUpdate,
  type CommandRunner,
  type UpdateOptions,
} from "./updates.js";
import { REVERIE_VERSION } from "./version.js";

/**
 * The HTTP surface: /rpc for the module, and /host for the things that belong
 * to the host rather than to the memory module: the review queue, the audit
 * log, the event feed, the config, the opt-in update check and the desktop
 * app install. Lifted from Fellowship's server.ts,
 * without the media route, the avatar preview and the drafter routes, which
 * Reverie does not have. The built UI is served from disk when there is one
 * (uiDir, or REVERIE_UI_DIR), and every other path falls back to its
 * index.html so a deep link opens the right screen. With no build, `/`
 * answers one plain line saying so.
 *
 * Every request passes the owner guard first (guard.ts): loopback names only,
 * and no write from a page on another origin.
 */

/** Fellowship's host defaults to 4319. Reverie's sits ten above it, so both can run. */
export const DEFAULT_PORT = 4329;
export const PORT_ENV = "REVERIE_PORT";

/**
 * Loopback only, and not configurable. docs/SPEC.md section 9: there is no
 * auth in a single user app, so an interface it listens on is an interface
 * your memories are readable from. Fellowship lets an env var widen this;
 * Reverie does not.
 */
export const HOSTNAME = "127.0.0.1";

export const NO_UI_TEXT =
  "Reverie is running. The UI is not built: run pnpm build, or point REVERIE_UI_DIR at a built packages/ui/dist. POST /rpc and the MCP server (reverie mcp) work either way.\n";

/** Where the built UI is, when no option says. */
export const UI_DIR_ENV = "REVERIE_UI_DIR";

export interface AppOptions {
  /** The built UI. Omitted, or missing on disk, serves NO_UI_TEXT on `/` instead. */
  uiDir?: string;
  /** Seams for the update check and the app install, so a test reaches neither GitHub nor the claude CLI. */
  updates?: UpdateOptions & {
    run?: CommandRunner;
    claudePath?: string | null;
    app?: Omit<AppInstallSeams, "fetch">;
  };
}

const EXPECTED_JSON = "Expected a JSON request with content-type application/json.";

/**
 * The update and app routes take JSON only, as /rpc does in the guard: a
 * browser cannot send a cross-origin JSON post without a preflight, which this
 * host never answers. The guard has already refused a write from another
 * origin; this is the second lock on routes that run a command or download.
 */
function isJson(contentType: string | undefined): boolean {
  return (contentType ?? "").toLowerCase().startsWith("application/json");
}

export function createApp(host: MiniHost, options: AppOptions = {}): Hono {
  const app = new Hono();

  app.use("*", ownerGuard());

  // pid and fingerprint let a client tell this process apart from another
  // host, and this code apart from older code.
  app.get("/health", (context) =>
    context.json({
      ok: true,
      silo: host.siloPath,
      hostDb: host.hostPath,
      tools: host.api.describe().length,
      pid: process.pid,
      fingerprint: fingerprint(),
    }),
  );

  app.route("/rpc", rpcRoutes(host));

  const hostRoutes = new Hono();

  hostRoutes.get("/review", (context) => {
    const state = context.req.query("state") ?? "pending";
    const allowed = ["pending", "confirmed", "discarded", "all"] as const;
    const chosen = (allowed as readonly string[]).includes(state)
      ? (state as (typeof allowed)[number])
      : "pending";
    return context.json({ proposals: host.store.listProposals(chosen) });
  });

  /**
   * The owner's decision, through the same tool an assistant would call. A UI
   * clicking Confirm is the owner saying yes, which is what confirmedByUser
   * means; the tool runs the write and marks the row, or refuses and leaves it
   * pending.
   */
  hostRoutes.post("/review/:id/:decision", async (context) => {
    const decision = context.req.param("decision");
    if (decision !== "confirm" && decision !== "reject") {
      return context.json({ ok: false, error: "Expected confirm or reject" }, 400);
    }

    try {
      const result = (await host.api.invoke("memory.decide", {
        proposalId: context.req.param("id"),
        decision,
        confirmedByUser: true,
      })) as Record<string, unknown>;

      return context.json({ ok: true, ...result });
    } catch (error) {
      if (error instanceof coreTools.ToolError) {
        const status = error.code === "not_found" ? 404 : 409;
        return context.json(
          {
            ok: false,
            error: { code: error.code, message: error.message, detail: error.detail },
          },
          status,
        );
      }
      return context.json(
        {
          ok: false,
          error: {
            code: "failed",
            message: error instanceof Error ? error.message : String(error),
          },
        },
        500,
      );
    }
  });

  hostRoutes.get("/audit", (context) =>
    context.json({ entries: host.store.listAudit(limitOf(context.req.query("limit"))) }),
  );

  hostRoutes.get("/events", (context) =>
    context.json({ events: host.store.listEvents(limitOf(context.req.query("limit"))) }),
  );

  hostRoutes.get("/config", (context) => context.json({ config: host.config() }));

  /**
   * A config change goes through the settings port, which re-embeds every
   * memory before a change to embedding.model counts as applied.
   */
  hostRoutes.post("/config", async (context) => {
    let patch: Record<string, unknown>;
    try {
      patch = (await context.req.json()) as Record<string, unknown>;
    } catch {
      return context.json({ error: "Expected a JSON body" }, 400);
    }

    try {
      const config = await host.ports.settings.set(patch);
      return context.json({ config });
    } catch (error) {
      return context.json(
        { error: error instanceof Error ? error.message : String(error) },
        400,
      );
    }
  });

  /**
   * The plugin update check. Off until the owner turns it on; see updates.ts
   * for what it sends and where the answer is cached. Lifted from
   * Fellowship's server.ts, with one change: a refresh that skips the cache
   * is POST /updates/check rather than GET /updates?refresh=1, so a page on
   * another origin cannot make this host call GitHub (the guard lets a
   * cross-origin GET through, since it cannot read the answer).
   */
  const updates = options.updates ?? {};
  const { app: appSeams, ...updateSeams } = updates;
  const updatesEnabled = () => host.store.readSetting(UPDATES_SETTING) === true;
  const updateStatus = (force: boolean) =>
    checkForUpdates({ ...updateSeams, enabled: updatesEnabled(), hostDbPath: host.hostPath, force });

  hostRoutes.get("/updates", async (context) => context.json(await updateStatus(false)));

  hostRoutes.post("/updates/check", async (context) => {
    if (!isJson(context.req.header("content-type"))) return context.json({ error: EXPECTED_JSON }, 415);
    return context.json(await updateStatus(true));
  });

  hostRoutes.post("/updates/settings", async (context) => {
    if (!isJson(context.req.header("content-type"))) return context.json({ error: EXPECTED_JSON }, 415);
    const body = (await context.req.json().catch(() => null)) as { enabled?: unknown } | null;
    if (typeof body?.enabled !== "boolean") {
      return context.json({ error: "Expected { enabled: true | false }" }, 400);
    }
    host.store.writeSetting(UPDATES_SETTING, body.enabled);
    return context.json(await updateStatus(body.enabled));
  });

  /** Runs claude plugin update, and brings an installed Reverie.app along. */
  hostRoutes.post("/updates/install", async (context) => {
    if (!isJson(context.req.header("content-type"))) {
      return context.json({ ok: false, message: EXPECTED_JSON }, 415);
    }
    const result = await installUpdate({
      ...(updateSeams.env ? { env: updateSeams.env } : {}),
      ...(updateSeams.run ? { run: updateSeams.run } : {}),
      ...(updateSeams.claudePath === undefined ? {} : { claudePath: updateSeams.claudePath }),
      app: { ...appSeams, ...(updateSeams.fetch ? { fetch: updateSeams.fetch } : {}) },
    });
    return context.json(result, result.ok ? 200 : 502);
  });

  /**
   * Reverie.app, installed on request: the build attached to the release
   * that matches this host's own version.
   */
  const appEnv = updateSeams.env ?? process.env;

  hostRoutes.get("/app", (context) =>
    context.json({
      ...desktopAppStatus(appEnv),
      ...(appSeams?.supported === undefined ? {} : { supported: appSeams.supported }),
      available: REVERIE_VERSION,
    }),
  );

  hostRoutes.post("/app/install", async (context) => {
    if (!isJson(context.req.header("content-type"))) {
      return context.json({ ok: false, message: EXPECTED_JSON }, 415);
    }
    const result = await installDesktopApp({
      version: REVERIE_VERSION,
      env: appEnv,
      ...(updateSeams.fetch ? { fetch: updateSeams.fetch } : {}),
      ...appSeams,
    });
    return context.json(result, result.ok ? 200 : 502);
  });

  app.route("/host", hostRoutes);

  const uiDir = options.uiDir;
  if (uiDir && existsSync(join(uiDir, "index.html"))) {
    uiRoutes(app, uiDir);
  } else {
    app.get("/", (context) => context.text(NO_UI_TEXT));
  }

  return app;
}

/**
 * The built SPA, plus a fallback so a deep link such as
 * /memory/LIF/GTH/2026-12-24/001 is served the shell rather than a 404. The
 * host owns /rpc, /host and /health, which are routed before this, so the
 * fallback only ever answers what is left. Lifted from Fellowship's
 * uiRoutes.
 */
function uiRoutes(app: Hono, dir: string): void {
  const index = join(dir, "index.html");

  // Vite fingerprints these, so they can be cached hard. Set once the file
  // is found: serveStatic's own onFound runs after its response is built,
  // too late for a header to stick.
  app.use("/assets/*", async (context, next) => {
    await next();
    if (context.res.status === 200) context.res.headers.set("cache-control", "public, max-age=31536000, immutable");
  });
  app.use("/assets/*", serveStatic({ root: dir }));
  app.use("/favicon.svg", serveStatic({ root: dir }));

  app.get("*", (context) => {
    // A script or a fetch asking for a file that is not there gets a 404,
    // not a page of HTML it cannot use.
    const accept = context.req.header("accept") ?? "";
    if (!accept.includes("text/html")) return context.body(null, 404);
    return context.html(readFileSync(index, "utf8"));
  });
}

function limitOf(raw: string | undefined): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) return 100;
  return Math.min(parsed, 1000);
}

let cachedFingerprint: string | undefined;

/** Computed once: it hashes every tool schema and migration. */
export function fingerprint(): string {
  cachedFingerprint ??= surfaceFingerprint();
  return cachedFingerprint;
}

export interface ServeOptions extends MiniHostOptions {
  /**
   * Take host.lock so a second host over the same files refuses to start.
   * On by default; a test serving throwaway files may turn it off.
   */
  lock?: boolean;
  /** 0 asks the OS for a free port. */
  port?: number;
  /** The built UI. Defaults to REVERIE_UI_DIR; with neither, `/` says the UI is not built. */
  uiDir?: string;
}

export interface RunningHost {
  host: MiniHost;
  port: number;
  url: string;
  close(): Promise<void>;
}

/** The port to listen on: the option, else REVERIE_PORT, else the default. */
export function resolvePort(env: NodeJS.ProcessEnv = process.env, given?: number): number {
  if (given !== undefined) return given;
  const configured = Number(env[PORT_ENV]);
  return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_PORT;
}

/** Opens both files, wires the ports and listens. One process, one writer. */
export async function serveMiniHost(options: ServeOptions = {}): Promise<RunningHost> {
  const env = options.env ?? process.env;
  const lockPath = hostLockPath(options.hostDbPath ?? resolveHostDbPath(env));
  const locking = options.lock !== false;
  // Taken before the files are opened, so a refused host never touches them.
  if (locking) await acquireHostLock(lockPath, describeThisProcess(fingerprint(), env));

  let host: MiniHost;
  try {
    host = await startMiniHost(options);
  } catch (error) {
    if (locking) releaseHostLock(lockPath);
    throw error;
  }
  const uiDir = options.uiDir ?? env[UI_DIR_ENV]?.trim();
  const app = createApp(host, uiDir ? { uiDir } : {});
  const port = resolvePort(env, options.port);

  // The port is only known once the socket is bound, which matters when it
  // was 0 and the OS picked one.
  const { server, actual } = await new Promise<{
    server: ReturnType<typeof serve>;
    actual: number;
  }>((resolve, reject) => {
    const instance = serve({ fetch: app.fetch, port, hostname: HOSTNAME }, (info) => {
      resolve({ server: instance, actual: info.port });
    });
    instance.once("error", reject);
  }).catch(async (error: unknown) => {
    await host.close();
    if (locking) releaseHostLock(lockPath);
    throw error;
  });

  const url = `http://${HOSTNAME}:${actual}`;
  const dropLock = () => releaseHostLock(lockPath);

  // The re-embed hook's restart half (docs/SPEC.md section 17): a re-embed a
  // previous process left half done is finished here, and vectors an earlier
  // write could not compute are filled. In the background: the host answers
  // at once, on FTS alone until it is done, and says so in every recall.
  const embedding = host.embedding.resume().then(
    (report) => {
      if (report.ran !== "none" && (report.embedded > 0 || !report.complete)) {
        process.stderr.write(
          `Vectors: ${report.ran === "reembed" ? "finished the re-embed" : "filled"} with ${report.model}, ${report.embedded} written${report.complete ? "" : `, ${report.failed} still missing (${report.reason ?? "unknown reason"})`}.\n`,
        );
      }
    },
    (error: unknown) => {
      process.stderr.write(`Vectors: ${error instanceof Error ? error.message : String(error)}\n`);
    },
  );
  if (locking) {
    updateHostLock(lockPath, { port: actual, url });
    // A process that exits without close() still drops its own lock.
    process.once("exit", dropLock);
  }

  return {
    host,
    port: actual,
    url,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      // A run still going is left: it resumes from the silo next time.
      await Promise.race([embedding, new Promise((done) => setTimeout(done, 2000).unref())]);
      await host.close();
      if (locking) {
        releaseHostLock(lockPath);
        process.removeListener("exit", dropLock);
      }
    },
  };
}
