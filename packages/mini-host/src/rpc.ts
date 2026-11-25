import { Hono } from "hono";

import { tools as coreTools } from "@reverie/core";

import type { MiniHost } from "./host.js";

/**
 * POST /rpc, the one way in. Lifted from Fellowship's rpc.ts.
 *
 * The UI gets no privileged path: it calls the same registry the stdio MCP
 * server calls, with the same validation and the same audit line. There is no
 * route that reaches the silo directly, which is what keeps the contract
 * honest rather than merely stated.
 */

export interface RpcRequest {
  tool: string;
  input?: unknown;
}

export type RpcResponse =
  | { ok: true; tool: string; result: unknown }
  | { ok: false; tool: string; error: { code: string; message: string; detail?: unknown } };

const STATUS: Record<string, number> = {
  unknown_tool: 404,
  invalid_input: 400,
  not_found: 404,
  refused: 409,
  conflict: 409,
  unavailable: 503,
  not_implemented: 501,
};

export function rpcRoutes(host: MiniHost): Hono {
  const app = new Hono();

  /** What this module can do, for a client building a palette or a menu. */
  app.get("/tools", (context) => context.json({ tools: host.api.describe() }));

  app.post("/", async (context) => {
    let body: RpcRequest;
    try {
      body = (await context.req.json()) as RpcRequest;
    } catch {
      return context.json(
        {
          ok: false,
          tool: "",
          error: { code: "invalid_input", message: "Expected a JSON body" },
        } satisfies RpcResponse,
        400,
      );
    }

    const tool = typeof body?.tool === "string" ? body.tool : "";
    if (!tool) {
      return context.json(
        {
          ok: false,
          tool,
          error: { code: "invalid_input", message: 'Expected { "tool": "memory.recall" }' },
        } satisfies RpcResponse,
        400,
      );
    }

    try {
      const result = await host.api.invoke(tool, body.input ?? {});
      return context.json({ ok: true, tool, result } satisfies RpcResponse);
    } catch (error) {
      if (error instanceof coreTools.ToolError) {
        return context.json(
          {
            ok: false,
            tool,
            error: {
              code: error.code,
              message: error.message,
              ...(error.detail === undefined ? {} : { detail: error.detail }),
            },
          } satisfies RpcResponse,
          (STATUS[error.code] ?? 400) as 400,
        );
      }

      // An unexpected failure is not reshaped into a refusal: the caller
      // should be able to tell "you asked for something I will not do" from
      // "something here is broken".
      const message = error instanceof Error ? error.message : String(error);
      return context.json(
        { ok: false, tool, error: { code: "failed", message } } satisfies RpcResponse,
        500,
      );
    }
  });

  return app;
}
