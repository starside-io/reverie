---
description: Set up Reverie's library: sections, shelves, projects and what to bring in
allowed-tools:
  - Read
---

Set up the owner's library in Reverie.

## If the tools are missing

This command drives the `memory_*` tools of the bundled MCP server. If they
are not available in this session: say so in one line and stop. Do not write
the memory to a file, a note, or anywhere else instead. A memory kept somewhere
Reverie cannot see is a memory that is never recalled, reviewed or forgotten.

## What this command does

1. `memory_shelves` to see what is there. A fresh silo has the seeded set:
   Work, Life, Craft, Reference and a front desk with a Returns shelf.
2. Ask what the owner actually wants on the shelves: their projects, the parts
   of life worth keeping apart. Adjust with `memory_set_shelves` (`action`:
   `create_section`, `create_shelf`, `rename_shelf`, `merge_shelves` and the
   rest). Give each new shelf a one line `description` written for whoever
   shelves into it later.
3. **Define the projects.** Ask where the list comes from:
   - a GitHub account or organisation: list its repositories with your own
     tools (Reverie reaches no network), let the owner pick, then ask which
     local folders hold each one. A project can have several folders.
   - a README or other file that lists current projects: read it and propose
     one project per entry.
   - by hand.
   Show the shelf and tag a project would get with `memory_set_projects
   { action: "propose" }`, then write it with `{ action: "create" }`: slug,
   name, `repoUrl`, the shelf and tag, and its local `folders`. `memory_projects`
   lists what is registered and which project this session resolves to.
4. Offer to bring in what already exists, each one with a yes:
   - a Reverie snapshot file: `memory_import { from: "snapshot", snapshot }`
     in merge mode, with the file's JSON as `snapshot`.
   - a markdown mirror folder: `memory_import { from: "markdown", folder }`,
     the folder as an absolute path.
   - this project's Claude Code memory directory, the folder with
     `MEMORY.md` in it: `memory_import { from: "claude_code", folder,
     project }`, with the project's slug from step 3 when the directory
     belongs to one. It is imported once and never written to.
   Run each with `dryRun: true` first and show the owner what it would
   write, file by file. Never copy files in by hand.
5. Say whether Fellowship is installed, because that decides whether people in
   a memory become references or stay as names.
6. Explain the two settings that change how it feels: auto-accept (off by
   default) and incognito. No tool changes settings: they are the host's
   config, read and set at `/host/config` on a running `reverie serve`
   (see `/reverie:open`).

## Rules

- Section and shelf codes are permanent once issued; names are not. Pick codes
  with that in mind and say so.
- Create a project only for a repository or an entry the owner picked. A
  folder belongs to one project at most.
- Local folder paths stay on this machine. They are not part of an export.
- Do not create shelves speculatively. An empty building with a Returns shelf
  works; shelves are cheap to add when the first memory needs one.
- Import merges. A replace runs a `dryRun` first, shows the owner
  `wouldDestroy`, and only then runs with the acknowledgement it returned.
