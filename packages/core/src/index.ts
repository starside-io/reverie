// M1: config, the silo, the schemas, and the domain. Tools, ports and
// activation land from M2.

// The types a host needs by name, lifted to the entry so it does not have to
// reach into a namespace for them.
export type { ModuleConfig } from "./config/index.js";
export type { Silo } from "./storage/client.js";

export * as config from "./config/index.js";
export * as domain from "./domain/index.js";
export * as schemas from "./schemas/index.js";
export * as storage from "./storage/index.js";
