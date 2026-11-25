---
description: Run a consolidation pass over Reverie and queue what it proposes
argument-hint: [shelf or #tag to limit the pass]
allowed-tools:
  - Read
---

Consolidate Reverie: find duplicates, contradictions and stale entries, and
propose what to do about each. Limited to `$ARGUMENTS` when given.

## If the tools are missing

This command drives the `memory_*` tools of the bundled MCP server. If they
are not available in this session: say so in one line and stop. Do not write
the memory to a file, a note, or anywhere else instead. A memory kept somewhere
Reverie cannot see is a memory that is never recalled, reviewed or forgotten.

## What this command does

1. `memory.draft_context { job: "consolidate" }` for the material, the rules
   and the schema.
2. Reason over it. Propose, per finding: merge two entries that say the same
   thing, supersede one that a later entry replaced, retire one that no longer
   holds, or reshelve one that is on the wrong shelf.
3. Hand the answer to `memory.propose_draft`. It is validated and queued.
4. Report what was queued and point the owner at `/reverie:review`.

## Rules

- **Consolidation proposes. It never applies.** Nothing changes until the
  owner decides in review. A pass that rewrites what is known unseen is how
  trust in a memory ends.
- A contradiction is surfaced, not resolved by picking the newer one. Which is
  true is the owner's call.
- Never propose forgetting. Retire at most.
- Leave anything pinned alone unless it is contradicted.
