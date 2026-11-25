import type { z } from "zod";

import type { ModuleConfig } from "../config/index.js";
import { CALL_NUMBER_PATTERN } from "../domain/catalogue/call-number.js";
import { DomainError } from "../domain/errors.js";
import type { AuditIds, HostPorts, ModuleEventName } from "../ports.js";
import type { Silo } from "../storage/client.js";

/**
 * One registry, two transports. POST /rpc, the stdio MCP server, the memory
 * tool adapter and the plugin hooks all come through invokeTool, so they hit
 * the same handlers with the same validation and the same audit line. The UI
 * gets no privileged path: anything it can do, an assistant can do.
 *
 * Lifted from Fellowship's packages/core/src/tools/registry.ts. What Reverie
 * adds: the session a call runs in (for project resolution and session or
 * agent scope), the incognito refusal for every tool that writes, a queue for
 * events so none goes out before the handler's transactions have committed,
 * DomainError mapped onto ToolError, and audit ids in place of a person id.
 */

export type ToolKind = "read" | "write" | "needs-ok";

/**
 * Where the caller says it is working. The transport fills it; core reads it
 * to resolve the project (section 4) and to scope session and agent memories.
 * Every field may be null: a call with no session is a global one.
 */
export interface SessionInfo {
  /** The working session's id. The scopeRef of a `session` memory. */
  id: string | null;
  /** The session's working folder, absolute, as the caller saw it. */
  folder: string | null;
  /** The folder's git remote, when there is one. Core normalises it. */
  gitRemote: string | null;
  /** The agent's name, as the caller gives it. The scopeRef of an `agent` memory. */
  agent: string | null;
}

export const NO_SESSION: SessionInfo = Object.freeze({
  id: null,
  folder: null,
  gitRemote: null,
  agent: null,
});

/** What every handler receives. */
export interface ToolContext {
  ports: HostPorts;
  db: Silo;
  config: ModuleConfig;
  /** Fixed for the whole call, so two reads inside one handler agree. Tests pin it. */
  now: Date;
  session: SessionInfo;
  /**
   * The pause switch, read from config for this call. The registry already
   * refuses every write and needs-ok tool while it is on, so a handler sees
   * true only in a read; a read may use it to say that capture is paused.
   */
  incognito: boolean;
  /** Who a version written by this call is attributed to: "user", "proposal:<id>". */
  actor: string;
  /**
   * Queues an event. The registry emits the queue once the handler has
   * returned, so after every transaction it awaited has committed, and drops
   * it when the handler throws. Call it right after the commit it describes.
   * Payloads carry ids and call numbers, never memory text.
   */
  emit(name: ModuleEventName, payload: Record<string, unknown>): void;
  /**
   * Runs another tool through the registry, validated and audited like any
   * call, in the same session and at the same now. This is how confirming a
   * proposal runs the tool it proposed: no handler reaches past the registry
   * to another handler's body.
   */
  invoke(name: string, input: unknown, options?: { actor?: string }): Promise<unknown>;
}

export interface ToolDefinition<Input = unknown, Output = unknown> {
  /** Namespaced, as the manifest lists it: "memory.recall". */
  name: string;
  title: string;
  kind: ToolKind;
  summary: string;
  input: z.ZodType<Input, z.ZodTypeDef, unknown>;
  handler: (ctx: ToolContext, input: Input) => Promise<Output>;
  /**
   * The ids and call numbers this call touched, for the audit line. `result`
   * is undefined when the call failed. Anything that is not an id or a call
   * number is dropped by the registry before it is logged. Method syntax on
   * purpose, so a tool typed by its own output still fits the registry.
   */
  auditIds?(input: Input, result: Output | undefined): AuditIds | undefined;
}

export type ToolErrorCode =
  | "unknown_tool"
  | "invalid_input"
  | "not_found"
  | "refused"
  | "conflict"
  | "unavailable"
  | "not_implemented";

/** A refusal the caller can act on, as opposed to an unexpected failure. */
export class ToolError extends Error {
  readonly code: ToolErrorCode;
  readonly detail?: unknown;

  constructor(code: ToolErrorCode, message: string, detail?: unknown) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

/**
 * A DomainError as the ToolError a caller sees: the codes are the same set on
 * purpose. Anything else passes through untouched, as an unexpected failure.
 */
export function toToolError(error: unknown): unknown {
  if (error instanceof ToolError) return error;
  if (error instanceof DomainError) return new ToolError(error.code, error.message, error.detail);
  return error;
}

export function defineTool<Input, Output>(
  definition: ToolDefinition<Input, Output>,
): ToolDefinition<Input, Output> {
  return definition;
}

/** Any tool, as the registry holds it. */
export type AnyTool = ToolDefinition<never, unknown>;

export interface ToolRegistry {
  readonly tools: readonly AnyTool[];
  byName(name: string): AnyTool | undefined;
  names(): string[];
}

export function createRegistry(definitions: readonly AnyTool[]): ToolRegistry {
  const byName = new Map<string, AnyTool>();
  for (const definition of definitions) {
    if (byName.has(definition.name)) {
      throw new Error(`Two tools are named "${definition.name}"`);
    }
    byName.set(definition.name, definition);
  }

  return {
    tools: definitions,
    byName: (name) => byName.get(name),
    names: () => [...byName.keys()],
  };
}

/** MCP tool names avoid dots, which some clients reject: memory.recall is memory_recall. */
export function mcpName(toolName: string): string {
  return toolName.replace(/\./g, "_");
}

/** The registry name an MCP name stands for, or undefined. */
export function fromMcpName(registry: ToolRegistry, name: string): string | undefined {
  return registry.tools.find((tool) => mcpName(tool.name) === name)?.name;
}

export const INCOGNITO_MESSAGE =
  "Incognito is on, so nothing is written: no memory, no note, no proposal. Reads still answer. The owner turns incognito off in settings to write again.";

/** The refusal every write and needs-ok tool gives while incognito is on (section 7). */
export function incognitoRefusal(): ToolError {
  return new ToolError("refused", INCOGNITO_MESSAGE, { incognito: true });
}

export interface InvokeOptions {
  /** Pinned by tests. Defaults to the moment the call starts. */
  now?: Date;
  /** Where the caller is working. Missing fields are null. */
  session?: Partial<SessionInfo>;
  /** Defaults to "user". decide passes "proposal:<id>". */
  actor?: string;
}

function sessionOf(input: Partial<SessionInfo> | undefined): SessionInfo {
  return {
    id: input?.id ?? null,
    folder: input?.folder ?? null,
    gitRemote: input?.gitRemote ?? null,
    agent: input?.agent ?? null,
  };
}

/**
 * Validate, run, audit. Every call is audited whatever its outcome, because an
 * attempt that was refused is the half worth being able to read back.
 */
export async function invokeTool(
  registry: ToolRegistry,
  ports: HostPorts,
  name: string,
  rawInput: unknown,
  options: InvokeOptions = {},
): Promise<unknown> {
  const tool = registry.byName(name);
  if (!tool) {
    throw new ToolError("unknown_tool", `No tool named "${name}"`);
  }

  const now = options.now ?? new Date();
  const parsed = tool.input.safeParse(rawInput ?? {});
  if (!parsed.success) {
    await audit(ports, tool, now, undefined, { refused: "invalid_input" });
    throw new ToolError("invalid_input", `${tool.name} was called with invalid input`, {
      issues: parsed.error.issues,
    });
  }

  const input = parsed.data as never;
  const config = await ports.settings.get();
  const session = sessionOf(options.session);

  if (tool.kind !== "read" && config.incognito) {
    await audit(ports, tool, now, safeIds(tool, input, undefined), { refused: "incognito" });
    throw incognitoRefusal();
  }

  const queued: Array<{ name: ModuleEventName; payload: Record<string, unknown> }> = [];
  const ctx: ToolContext = {
    ports,
    db: ports.storage.silo(),
    config,
    now,
    session,
    incognito: config.incognito,
    actor: options.actor ?? "user",
    emit: (event, payload) => {
      queued.push({ name: event, payload });
    },
    invoke: (next, nextInput, nested) =>
      invokeTool(registry, ports, next, nextInput, {
        now,
        session,
        actor: nested?.actor ?? options.actor ?? "user",
      }),
  };

  let result: unknown;
  try {
    result = await tool.handler(ctx, input);
    for (const event of queued) await ports.bus.emit(event.name, event.payload);
  } catch (raw) {
    const error = toToolError(raw);
    const code = error instanceof ToolError ? error.code : "failed";
    await audit(ports, tool, now, safeIds(tool, input, undefined), { refused: code });
    throw error;
  }

  await audit(ports, tool, now, safeIds(tool, input, result), auditDetail(result));
  return result;
}

/** A host id or a uuid: no spaces, no prose. */
const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

function cleanList(values: unknown, pattern: RegExp): string[] | undefined {
  if (!Array.isArray(values)) return undefined;
  const kept = values.filter((value): value is string => typeof value === "string" && pattern.test(value));
  return kept.length > 0 ? [...new Set(kept)] : undefined;
}

/**
 * The ids a tool reports, filtered to what an id or a call number can look
 * like. A tool that hands back a title by mistake logs nothing for it.
 */
function safeIds(tool: AnyTool, input: never, result: unknown): AuditIds | undefined {
  let raw: AuditIds | undefined;
  try {
    raw = tool.auditIds?.(input, result);
  } catch {
    raw = undefined;
  }
  if (!raw) return undefined;
  const ids: AuditIds = {};
  const memoryIds = cleanList(raw.memoryIds, ID_PATTERN);
  const calls = cleanList(raw.calls, CALL_NUMBER_PATTERN);
  const proposalIds = cleanList(raw.proposalIds, ID_PATTERN);
  if (memoryIds) ids.memoryIds = memoryIds;
  if (calls) ids.calls = calls;
  if (proposalIds) ids.proposalIds = proposalIds;
  return Object.keys(ids).length > 0 ? ids : undefined;
}

/**
 * What goes in the audit line from a result. Counts and flags only: numbers
 * and booleans at the top level, and the length of each array. No string is
 * ever copied, so no title, body, quote or query lands in the log.
 */
function auditDetail(result: unknown): Record<string, unknown> | undefined {
  if (!result || typeof result !== "object") return undefined;
  const detail: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(result as Record<string, unknown>)) {
    if (typeof value === "number" || typeof value === "boolean") detail[key] = value;
    else if (Array.isArray(value)) detail[`${key}Count`] = value.length;
  }
  return Object.keys(detail).length > 0 ? detail : undefined;
}

async function audit(
  ports: HostPorts,
  tool: AnyTool,
  at: Date,
  ids: AuditIds | undefined,
  detail?: Record<string, unknown>,
): Promise<void> {
  await ports.audit.log({
    tool: tool.name,
    kind: tool.kind,
    at,
    ...(ids ? { ids } : {}),
    ...(detail ? { detail } : {}),
  });
}
