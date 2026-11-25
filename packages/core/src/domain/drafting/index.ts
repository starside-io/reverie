/**
 * Drafting: what any model is asked, what it may answer, and what ties the
 * answer back to the material. docs/SPEC.md sections 13 and 15.
 *
 * An answer becomes proposals in the review queue, never rows in the silo.
 * The model proposes; the owner confirms; the module never calls a model.
 */
export * from "./context.js";
export * from "./gates.js";
export * from "./prompts.js";
export * from "./schemas.js";
