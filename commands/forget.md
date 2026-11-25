---
description: Permanently forget a memory in Reverie
argument-hint: <call number, or a description of the memory>
allowed-tools:
  - Read
---

Forget the memory `$ARGUMENTS` names. This cannot be undone.

## If the tools are missing

This command drives the `memory_*` tools of the bundled MCP server. If they
are not available in this session: say so in one line and stop. Do not write
the memory to a file, a note, or anywhere else instead. A memory kept somewhere
Reverie cannot see is a memory that is never recalled, reviewed or forgotten.

## What this command does

1. **Find exactly one memory.** By call number with `memory_get`, or by
   description with `memory_search`. More than one match: list them and ask.
2. **Show it in full**: call number, body and tags from `memory_get`, its
   sources from `memory_sources`, and how many versions it has from
   `memory_history`.
3. **Say what forgetting destroys**: the memory, the content of every version,
   its search entry, its vector, and any tag no other memory carries. One
   audit line remains, saying that something was forgotten and when. The call
   number is never reissued.
4. **Ask for a yes to that exact memory.** Only then `memory_forget` with its
   `call` and `confirmedByUser: true`.

## Rules

- "Forget that" in passing is not a confirmation. The owner must have seen
  the specific memory and said yes to it.
- If the owner only wants it out of the way, offer `memory_retire`: out of
  recall, history kept, reversible. Forget is for when it must be gone.
- Forgetting a memory does not touch a Fellowship occasion linked to it. The
  party still happened; say so if there is one.
- Never forget in bulk. One memory per confirmation.
