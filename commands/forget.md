---
description: Permanently forget a memory in Reverie
argument-hint: <call number, or a description of the memory>
allowed-tools:
  - Read
---

Forget the memory `$ARGUMENTS` names. This cannot be undone.

## Scaffold state

The tools this command drives do not exist yet. They arrive at **M2** in
[`docs/SPEC.md`](../docs/SPEC.md) and become reachable from a session at
**M3**, when `.mcp.json.example` is renamed to `.mcp.json`. Until then: say so
in one line and stop. Do not write the memory to a file, a note, or anywhere
else instead. A memory kept somewhere Reverie cannot see is a memory that is
never recalled, reviewed or forgotten.

## What this command does once the tools exist

1. **Find exactly one memory.** By call number with `memory.get`, or by
   description with `memory.search`. More than one match: list them and ask.
2. **Show it in full**: call number, body, tags, sources, and how many
   versions it has.
3. **Say what forgetting destroys**: the memory, the content of every version,
   its search entry and its vector. One audit line remains, saying that
   something was forgotten and when. The call number is never reissued.
4. **Ask for a yes to that exact memory.** Only then `memory.forget` with
   `confirmedByUser: true`.

## Rules

- "Forget that" in passing is not a confirmation. The owner must have seen
  the specific memory and said yes to it.
- If the owner only wants it out of the way, offer `memory.retire`: out of
  recall, history kept, reversible. Forget is for when it must be gone.
- Forgetting a memory does not touch a Fellowship occasion linked to it. The
  party still happened; say so if there is one.
- Never forget in bulk. One memory per confirmation.
