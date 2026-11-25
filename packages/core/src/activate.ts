import { deliverEvent, type DeliveryResult } from "./listeners.js";
import type { HostPorts, ListenedEventName } from "./ports.js";
import {
  invokeTool,
  registry,
  type AnyTool,
  type InvokeOptions,
  type ToolKind,
} from "./tools/index.js";

/**
 * What a host gets when it installs this module. The ports go in, a tool
 * surface comes out, and nothing else crosses the boundary. Lifted from
 * Fellowship's activate.ts.
 */
export interface ModuleApi {
  /** Every tool, with its zod input schema, for a transport to register. */
  readonly tools: readonly AnyTool[];
  /** Name, title, kind and one line each. No schemas, for a listing. */
  describe(): Array<{ name: string; title: string; kind: ToolKind; summary: string }>;
  /** Validated, run and audited. `options.session` says where the caller is working. */
  invoke(name: string, input: unknown, options?: InvokeOptions): Promise<unknown>;
  /**
   * The host's bus delivers each event this module listens to (section 18,
   * "Listened to") here, after the emitting side has committed. The answer
   * says what was done, in ids and counts. See listeners.ts.
   */
  deliver(
    name: ListenedEventName,
    payload: Record<string, unknown>,
    options?: { now?: Date },
  ): Promise<DeliveryResult>;
}

export function activate(ports: HostPorts): ModuleApi {
  return {
    tools: registry.tools,
    describe: () =>
      registry.tools.map((tool) => ({
        name: tool.name,
        title: tool.title,
        kind: tool.kind,
        summary: tool.summary,
      })),
    invoke: (name, input, options) => invokeTool(registry, ports, name, input, options),
    deliver: (name, payload, options) => deliverEvent(ports, name, payload, options),
  };
}
