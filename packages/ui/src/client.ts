/**
 * The only thing in this package that talks to the host.
 *
 * Every read and every write goes through POST /rpc, which is the same
 * registry an assistant reaches over MCP: no privileged path for the UI, no
 * second way into the database, and nothing here builds SQL. Lifted from
 * Fellowship's client.ts.
 *
 * One call leaves /rpc: the owner's decision on a proposal goes to
 * POST /host/review/:id/:decision, the route the mini-host keeps for its UI,
 * as Fellowship's does. That route runs memory.decide through the same
 * registry with confirmedByUser set, because the owner clicking Confirm is
 * the yes the flag stands for. A decision with parts (an occasion or a note
 * riding inside a proposal, decided one by one) goes over /rpc to
 * memory.decide instead, since the host route takes no parts.
 */

export type ToolErrorCode =
  | "unknown_tool"
  | "invalid_input"
  | "not_found"
  | "refused"
  | "conflict"
  | "unavailable"
  | "not_implemented"
  | "failed"
  | "unreachable";

export class RpcError extends Error {
  readonly code: ToolErrorCode;
  readonly detail: unknown;
  readonly tool: string;

  constructor(tool: string, code: ToolErrorCode, message: string, detail?: unknown) {
    super(message);
    this.name = "RpcError";
    this.tool = tool;
    this.code = code;
    this.detail = detail;
  }

  /** True when the caller can fix the input and try again. */
  get isInput(): boolean {
    return this.code === "invalid_input";
  }

  /** The field messages behind an invalid_input, when the host sent them. */
  get issues(): Array<{ path: string; message: string }> {
    const detail = this.detail as { issues?: Array<{ path?: unknown[]; message?: string }> };
    return (detail?.issues ?? []).map((issue) => ({
      path: (issue.path ?? []).join("."),
      message: issue.message ?? "Invalid",
    }));
  }
}

interface RpcSuccess<T> {
  ok: true;
  tool: string;
  result: T;
}

interface RpcFailure {
  ok: false;
  tool: string;
  error: { code: ToolErrorCode; message: string; detail?: unknown };
}

/** Where the host is. Same origin in the build, proxied in development. */
export const BASE = "";

export async function rpc<T>(tool: string, input: unknown = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool, input }),
    });
  } catch (error) {
    throw new RpcError(
      tool,
      "unreachable",
      `Could not reach the host. Is it running? (${error instanceof Error ? error.message : String(error)})`,
    );
  }

  let body: RpcSuccess<T> | RpcFailure;
  try {
    body = (await response.json()) as RpcSuccess<T> | RpcFailure;
  } catch {
    throw new RpcError(tool, "failed", `The host answered ${response.status} with no JSON.`);
  }

  if (!body.ok) {
    throw new RpcError(tool, body.error.code, body.error.message, body.error.detail);
  }
  return body.result;
}

export interface DecisionAnswer {
  ok: boolean;
  /** The refusal, when the write the proposal names did not happen. The proposal stays pending. */
  message?: string;
  /** The call number the confirmed write committed, when it committed a memory. */
  committed?: string | null;
}

export const host = {
  /**
   * The owner's yes or no to one whole proposal. Confirming runs the tool the
   * proposal names; a refusal leaves the proposal pending and says why.
   */
  async decide(id: string, decision: "confirm" | "reject"): Promise<DecisionAnswer> {
    let response: Response;
    try {
      response = await fetch(`${BASE}/host/review/${encodeURIComponent(id)}/${decision}`, { method: "POST" });
    } catch (error) {
      return {
        ok: false,
        message: `Could not reach the host. Is it running? (${error instanceof Error ? error.message : String(error)})`,
      };
    }
    const body = (await response.json().catch(() => null)) as {
      ok?: boolean;
      committed?: { call: string } | null;
      error?: { message?: string } | string;
    } | null;

    if (response.ok && body?.ok) return { ok: true, committed: body.committed?.call ?? null };

    const error = body?.error;
    return {
      ok: false,
      message: typeof error === "string" ? error : (error?.message ?? `The host answered ${response.status}`),
    };
  },
};
