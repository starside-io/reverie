/*
 * The whole tool surface: 41 tools. docs/SPEC.md section 15.
 *
 * module.json files them in three arrays, as the registry's ToolKind does:
 * 20 read (draft_context among them), 15 write (propose_draft among them),
 * 6 needs-ok. Section 15 presents the same 41 as four classes because that is
 * how they are used; drafting is a class in the documentation, not in the
 * type (section 2).
 *
 * HOW TO ADD OR BUILD A TOOL
 *
 * This file is the explicit list. Every one of the 41 names has a module
 * below, and no stub is left. A tool lives in:
 *
 *   read/<name>.ts      read tools                      (kind "read")
 *   write/<name>.ts     write tools                     (kind "write")
 *   confirm/<name>.ts   needs-ok tools                  (kind "needs-ok")
 *   drafting/<name>.ts  draft_context (read), propose_draft (write)
 *
 * The file name is the part after "memory.", underscores as hyphens:
 * memory.fs_view lives in read/fs-view.ts.
 *
 * In that file:
 *
 * 1. Keep `export const tool = defineTool({ ... })`, with the tool's name and
 *    kind as module.json files them. The manifest gate checks both.
 * 2. `input` is a zod object. Reuse the schemas in src/schemas and
 *    the pieces in tools/shared/inputs.ts (callSchema, confirmedByUser).
 *    Every needs-ok tool takes `confirmedByUser` (guardrail 1).
 * 3. `handler` is `async handler(ctx, input) { ... }`. It receives
 *    a ToolContext (tools/registry.ts): ports, db, config, now, session,
 *    incognito, actor, emit, invoke. It is a thin layer over src/domain: call
 *    the domain function, shape the answer, return it.
 * 4. Throw ToolError for a refusal the caller can act on. A DomainError
 *    thrown by the domain is mapped to a ToolError with the same code by the
 *    registry, so there is no need to catch it.
 * 5. After a commit, queue its event with ctx.emit(name, payload). The
 *    registry sends the queue only once the handler has returned, so never
 *    before a transaction commits, and drops it when the handler throws.
 *    Payloads carry ids and call numbers, never memory text.
 * 6. Add `auditIds: (input, result) => ({ memoryIds, calls, proposalIds })`
 *    so the audit line names what the call touched. The registry adds the
 *    counts and flags from the result by itself and never copies a string.
 * 7. Write tests under tests/tools/<folder>/<name>.test.ts against the test
 *    host in tests/test-host.ts.
 *
 * What the registry already does for every tool, so a handler does not:
 * validates the input, refuses every write and needs-ok tool while incognito
 * is on (reads still answer), maps DomainError to ToolError, emits queued
 * events after the handler returns, and writes one audit line per call
 * whatever the outcome.
 *
 * The helpers in tools/shared/ (discipline, the stated source, scope refs,
 * project resolution, people refs, the RecallLog row, the memory view) are
 * owned by phase 1. A tool that needs a helper of its own keeps it in its own
 * file, or in a new file in its own folder, so two people never edit the same
 * file at once.
 */

import { createRegistry, type AnyTool } from "./registry.js";

import { tool as recallTool } from "./read/recall.js";
import { tool as browseTool } from "./read/browse.js";
import { tool as getTool } from "./read/get.js";
import { tool as searchTool } from "./read/search.js";
import { tool as relatedTool } from "./read/related.js";
import { tool as aboutTool } from "./read/about.js";
import { tool as shelvesTool } from "./read/shelves.js";
import { tool as tagsTool } from "./read/tags.js";
import { tool as projectsTool } from "./read/projects.js";
import { tool as coreTool } from "./read/core.js";
import { tool as historyTool } from "./read/history.js";
import { tool as explainTool } from "./read/explain.js";
import { tool as sourcesTool } from "./read/sources.js";
import { tool as staleTool } from "./read/stale.js";
import { tool as conflictsTool } from "./read/conflicts.js";
import { tool as statsTool } from "./read/stats.js";
import { tool as exportTool } from "./read/export.js";
import { tool as reviewTool } from "./read/review.js";
import { tool as fsViewTool } from "./read/fs-view.js";
import { tool as draftContextTool } from "./drafting/draft-context.js";

import { tool as rememberTool } from "./write/remember.js";
import { tool as updateTool } from "./write/update.js";
import { tool as supersedeTool } from "./write/supersede.js";
import { tool as touchTool } from "./write/touch.js";
import { tool as pinTool } from "./write/pin.js";
import { tool as retireTool } from "./write/retire.js";
import { tool as shelveTool } from "./write/shelve.js";
import { tool as setTagsTool } from "./write/set-tags.js";
import { tool as setShelvesTool } from "./write/set-shelves.js";
import { tool as setProjectsTool } from "./write/set-projects.js";
import { tool as linkTool } from "./write/link.js";
import { tool as linkOccasionTool } from "./write/link-occasion.js";
import { tool as addSourceTool } from "./write/add-source.js";
import { tool as sessionNoteTool } from "./write/session-note.js";
import { tool as proposeDraftTool } from "./drafting/propose-draft.js";

import { tool as forgetTool } from "./confirm/forget.js";
import { tool as redactTool } from "./confirm/redact.js";
import { tool as promoteProcedureTool } from "./confirm/promote-procedure.js";
import { tool as mergeTool } from "./confirm/merge.js";
import { tool as importTool } from "./confirm/import.js";
import { tool as decideTool } from "./confirm/decide.js";

export * from "./registry.js";
export * as shared from "./shared/index.js";

/** 20, in module.json's order. */
export const readTools: readonly AnyTool[] = [
  recallTool,
  browseTool,
  getTool,
  searchTool,
  relatedTool,
  aboutTool,
  shelvesTool,
  tagsTool,
  projectsTool,
  coreTool,
  historyTool,
  explainTool,
  sourcesTool,
  staleTool,
  conflictsTool,
  statsTool,
  exportTool,
  reviewTool,
  fsViewTool,
  draftContextTool,
] as unknown as readonly AnyTool[];

/** 15, in module.json's order. */
export const writeTools: readonly AnyTool[] = [
  rememberTool,
  updateTool,
  supersedeTool,
  touchTool,
  pinTool,
  retireTool,
  shelveTool,
  setTagsTool,
  setShelvesTool,
  setProjectsTool,
  linkTool,
  linkOccasionTool,
  addSourceTool,
  sessionNoteTool,
  proposeDraftTool,
] as unknown as readonly AnyTool[];

/** 6, in module.json's order. */
export const confirmTools: readonly AnyTool[] = [
  forgetTool,
  redactTool,
  promoteProcedureTool,
  mergeTool,
  importTool,
  decideTool,
] as unknown as readonly AnyTool[];

/** The two drafting tools, already counted above under read and write. */
export const draftingTools: readonly AnyTool[] = [draftContextTool, proposeDraftTool] as unknown as readonly AnyTool[];

export const allTools: readonly AnyTool[] = [...readTools, ...writeTools, ...confirmTools];

export const registry = createRegistry(allTools);
