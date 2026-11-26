// The helpers every handler may use. Owned by phase 1: a tool that needs a
// helper of its own keeps it in its own file.

export { enforceDiscipline, refuseFindings } from "./discipline.js";
export { callSchema, confirmedByUser } from "./inputs.js";
export {
  clearReadyForExtraction,
  consolidationDue,
  endSession,
  readConsolidation,
  readReembed,
  readyForExtraction,
  READY_FOR_EXTRACTION_KEY,
  REEMBED_KEY,
  type ReembedState,
  transcriptPointer,
  transcriptPointers,
  TRANSCRIPTS_KEY,
  type ConsolidationState,
  type SessionEnded,
} from "./host-values.js";
export {
  isWithin,
  longestPathMatch,
  normaliseFolder,
  projectShelfPath,
  resolveProject,
  resolveProjectFor,
  type ProjectResolution,
} from "./project.js";
export { writeRecallLog, type RecallLogEntry } from "./recall-log.js";
export {
  buildRefs,
  personInputSchema,
  refFor,
  renderRef,
  type BuiltRefs,
  type PersonInput,
  type RenderedRef,
} from "./refs.js";
export { capQuote, scopeRefFor, statedSource } from "./session.js";
export { findByCall, memoryView, type FoundByCall, type MemoryView } from "./views.js";
