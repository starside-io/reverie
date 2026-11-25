// M2: config, the silo, the schemas, the domain, the ports, the tools and
// activation. The mini-host lands at M3.

export { activate, type ModuleApi } from "./activate.js";
export { LISTENED_EVENTS, type DeliveryResult } from "./listeners.js";
export * from "./ports.js";
export { surfaceFingerprint } from "./fingerprint.js";

// The types a host needs by name, lifted to the entry so it does not have to
// reach into a namespace for them.
export type { ModuleConfig } from "./config/index.js";
export type { Silo } from "./storage/client.js";
export type {
  InvokeOptions,
  SessionInfo,
  ToolContext,
  ToolDefinition,
  ToolKind,
} from "./tools/registry.js";

export * as config from "./config/index.js";
export * as domain from "./domain/index.js";
export * as schemas from "./schemas/index.js";
export * as storage from "./storage/index.js";
export * as tools from "./tools/index.js";
