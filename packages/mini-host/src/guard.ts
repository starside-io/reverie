import type { MiddlewareHandler } from "hono";

/**
 * Who may drive this host from a browser. docs/SPEC.md sections 1 and 9: one
 * user, no auth, 127.0.0.1 only.
 *
 * Listening on loopback keeps other machines out, but not other web pages:
 * any site open in the owner's browser can send a request to 127.0.0.1. A
 * page cannot read the answer without CORS, which this host never grants,
 * but a write does not need its answer read. Fellowship's host has no check
 * for this; Reverie adds three, because the UI acts as the owner and a
 * forget is for good.
 *
 * 1. The Host header must name loopback (127.0.0.1, localhost, [::1]). A
 *    DNS rebinding page reaches this socket under its own hostname, and is
 *    refused here before anything runs.
 * 2. A write (anything but GET, HEAD and OPTIONS) that carries an Origin
 *    must carry this host's own origin, and one marked cross-site or
 *    same-site by Sec-Fetch-Site is refused. Browsers always send Origin on a
 *    cross-origin POST. A client that is not a browser (curl, the CLI, a
 *    test) sends neither and is let through: it already runs as the owner.
 * 3. POST /rpc takes application/json only, so a browser can never send it
 *    as a "simple" request: a cross-origin page would need a preflight, and
 *    this host answers none.
 *
 * The UI on the same origin passes all three without doing anything.
 */

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export const REFUSED_HOST = "Refused: this host answers to 127.0.0.1 and localhost only.";
export const REFUSED_ORIGIN = "Refused: a page on another origin cannot write to this host.";
export const REFUSED_TYPE = "POST /rpc takes a JSON body with content-type application/json.";

export function ownerGuard(): MiddlewareHandler {
  return async (context, next) => {
    const url = new URL(context.req.url);
    if (!LOOPBACK.has(url.hostname)) return refuse(context.req.path, 403, REFUSED_HOST);

    const method = context.req.method.toUpperCase();
    if (!SAFE_METHODS.has(method)) {
      const origin = context.req.header("origin");
      if (origin !== undefined && origin !== url.origin) return refuse(context.req.path, 403, REFUSED_ORIGIN);
      const site = context.req.header("sec-fetch-site");
      if (site === "cross-site" || site === "same-site") return refuse(context.req.path, 403, REFUSED_ORIGIN);

      if (method === "POST" && (context.req.path === "/rpc" || context.req.path === "/rpc/")) {
        const type = (context.req.header("content-type") ?? "").toLowerCase();
        if (!type.startsWith("application/json")) return refuse(context.req.path, 415, REFUSED_TYPE);
      }
    }
    await next();
    return undefined;
  };
}

/** The refusal in the shape the route would have answered in, so a client reads it the same way. */
function refuse(path: string, status: 403 | 415, message: string): Response {
  const body = path.startsWith("/rpc")
    ? { ok: false, tool: "", error: { code: "refused", message } }
    : { ok: false, error: { code: "refused", message } };
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
