// One namespace per module, as in Fellowship, so two modules may use the same
// word for different things (a recall score and a reconcile neighbour's rank,
// a catalogue tag and a snapshot tag) without one shadowing the other.
export * as callNumber from "./catalogue/call-number.js";
export * as discipline from "./discipline.js";
export * as embeddings from "./embeddings.js";
export * as drafting from "./drafting/index.js";
export * as links from "./links.js";
export * as memories from "./memories.js";
export * as merge from "./merge.js";
export * as occasions from "./occasions.js";
export * as projects from "./projects.js";
export * as queries from "./queries/index.js";
export * as recall from "./recall/index.js";
export * as reconcile from "./reconcile.js";
export * as related from "./catalogue/related.js";
export * as sessionNotes from "./session-notes.js";
export * as shelving from "./catalogue/shelving.js";
export * as tags from "./catalogue/tags.js";
export * as transfer from "./transfer/index.js";
export * as versions from "./versions.js";
export { atomic, type Db, type Tx } from "./db.js";
export { DomainError, type DomainErrorCode } from "./errors.js";
