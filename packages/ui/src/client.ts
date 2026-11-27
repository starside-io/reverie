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
 *
 * The other calls that leave /rpc are the host's own, not the module's: the
 * opt-in plugin update check (/host/updates) and the desktop app
 * (/host/app), behind the Settings screen and the rail line. Lifted from
 * Fellowship's client.ts. Their writes are JSON posts, as /rpc is.
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

/** The plugin update check. Mirrors UpdateStatus in mini-host's updates.ts. */
export interface UpdateStatus {
  enabled: boolean;
  installed: {
    pluginId: string;
    marketplace: string;
    version: string;
    scope: string;
    installPath: string | null;
  } | null;
  latest: { version: string; tag: string; url: string; publishedAt: string | null } | null;
  updateAvailable: boolean;
  checkedAt: string | null;
  error: string | null;
  command: string | null;
}

export interface DesktopAppStatus {
  supported: boolean;
  path: string;
  /** The installed app's version, null when it is not installed. */
  version: string | null;
  /** The version an install would fetch: the host's own. */
  available: string;
}

export interface InstallResult {
  ok: boolean;
  message: string;
  output: string;
  command: string | null;
}

export interface AppInstallResult {
  ok: boolean;
  message: string;
  version: string | null;
}

type HostPath = `/host/${string}`;

async function hostGet<T>(path: HostPath): Promise<T> {
  const response = await fetch(`${BASE}${path}`);
  if (!response.ok) throw new Error(`The host answered ${response.status}`);
  return (await response.json()) as T;
}

/** A JSON post; the answer is read whatever the status, since a failure says what to do instead. */
async function hostPost<T>(path: HostPath, body: unknown): Promise<{ status: number; body: T | null }> {
  const response = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json().catch(() => null)) as T | null };
}

export const updates = {
  /** Never reaches the network while the check is off, and at most once a day while it is on. */
  status: () => hostGet<UpdateStatus>("/host/updates"),

  /** Asks GitHub now, past the day long cache. */
  async check(): Promise<UpdateStatus> {
    const answer = await hostPost<UpdateStatus>("/host/updates/check", {});
    if (!answer.body || answer.status !== 200) throw new Error(`The host answered ${answer.status}`);
    return answer.body;
  },

  async setEnabled(enabled: boolean): Promise<UpdateStatus> {
    const answer = await hostPost<UpdateStatus>("/host/updates/settings", { enabled });
    if (!answer.body || answer.status !== 200) throw new Error(`The host answered ${answer.status}`);
    return answer.body;
  },

  /** Runs claude plugin update on the host. The answer says what happened either way. */
  async install(): Promise<InstallResult> {
    const answer = await hostPost<InstallResult>("/host/updates/install", {});
    return answer.body ?? { ok: false, message: `The host answered ${answer.status}`, output: "", command: null };
  },

  app: () => hostGet<DesktopAppStatus>("/host/app"),

  /** Downloads the desktop app from the release; the answer says what happened either way. */
  async installApp(): Promise<AppInstallResult> {
    const answer = await hostPost<AppInstallResult>("/host/app/install", {});
    return answer.body ?? { ok: false, message: `The host answered ${answer.status}`, version: null };
  },
};
