---
description: Set up Reverie's library: sections, shelves, projects and what to bring in
allowed-tools:
  - Read
---

Set up the owner's library in Reverie.

## Scaffold state

The tools this command drives do not exist yet. They arrive at **M2** in
[`docs/SPEC.md`](../docs/SPEC.md) and become reachable from a session at
**M3**, when `.mcp.json.example` is renamed to `.mcp.json`. Until then: say so
in one line and stop. Do not write the memory to a file, a note, or anywhere
else instead. A memory kept somewhere Reverie cannot see is a memory that is
never recalled, reviewed or forgotten.

## What this command does once the tools exist

1. `memory.shelves` to see what is there. A fresh silo has the seeded set:
   Work, Life, Craft, Reference and a front desk with a Returns shelf.
2. Ask what the owner actually wants on the shelves: their projects, the parts
   of life worth keeping apart. Adjust with `memory.set_shelves`. Give each
   shelf a one line description written for whoever shelves into it later.
3. **Define the projects.** Ask where the list comes from:
   - a GitHub account or organisation: list its repositories with your own
     tools (Reverie reaches no network), let the owner pick, then ask which
     local folders hold each one. A project can have several folders.
   - a README or other file that lists current projects: read it and propose
     one project per entry.
   - by hand.
   Write each with `memory.set_projects`: slug, name, repository, the shelf
   and tag it gets, and its local folders. Show the shelf and tag before
   making them.
4. Offer to bring in an existing memory folder (markdown files with an index).
   That is `memory.import`, it needs a yes, and it shows the counts first.
5. Say whether Fellowship is installed, because that decides whether people in
   a memory become references or stay as names.
6. Explain the two settings that change how it feels: auto-accept (off by
   default) and incognito.

## Rules

- Section and shelf codes are permanent once issued; names are not. Pick codes
  with that in mind and say so.
- Create a project only for a repository or an entry the owner picked. A
  folder belongs to one project at most.
- Local folder paths stay on this machine. They are not part of an export.
- Do not create shelves speculatively. An empty building with a Returns shelf
  works; shelves are cheap to add when the first memory needs one.
- Import merges. It never replaces without naming what it would destroy.
