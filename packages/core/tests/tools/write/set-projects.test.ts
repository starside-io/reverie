import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SetProjectsResult } from "../../../src/tools/write/set-projects.js";
import { testHost, type TestHost } from "../../test-host.js";
import { NOW, siloText } from "./helpers.js";

const FOLDER = "/Users/jane.doe/code/glowfish-app";
const WORKTREE = "/Users/jane.doe/code/glowfish-worktree";

describe("memory.set_projects", () => {
  let host: TestHost;

  beforeEach(async () => {
    host = await testHost({ now: NOW });
  });
  afterEach(async () => {
    await host.close();
  });

  const set = (input: Record<string, unknown>) => host.invoke<SetProjectsResult>("memory.set_projects", input);

  it("proposes a shelf and a tag and writes nothing", async () => {
    const proposal = await set({ action: "propose", slug: "Glowfish", name: "Glowfish" });
    expect(proposal.proposal).toEqual({
      shelf: {
        existing: null,
        create: { section: "WRK", code: "GLO", name: "Glowfish", description: expect.stringContaining("Glowfish") },
      },
      tag: "glowfish",
      tagExists: false,
    });
    expect(await host.db.project.count()).toBe(0);
    expect(await host.db.shelf.count({ where: { code: "GLO" } })).toBe(0);

    const existing = await set({ action: "propose", slug: "nightstash", name: "NightStash" });
    expect(existing.proposal?.shelf).toEqual({ existing: "WRK/NST", create: null });
  });

  it("creates a project with the proposed shelf and tag, the repository normalised", async () => {
    const result = await set({
      action: "create",
      slug: "glowfish",
      name: "Glowfish",
      repoUrl: "git@github.com:janedoe/glowfish.git",
    });
    expect(result.project).toEqual({
      slug: "glowfish",
      name: "Glowfish",
      repoUrl: "github.com/janedoe/glowfish",
      shelf: "WRK/GLO",
      tag: "glowfish",
      description: null,
      archived: false,
    });
    expect(result.created).toEqual({ shelf: "WRK/GLO", tag: "glowfish" });
    expect(result.folders).toEqual([]);

    const onExisting = await set({ action: "create", slug: "nightstash", name: "NightStash" });
    expect(onExisting.project?.shelf).toBe("WRK/NST");
    expect(onExisting.created.shelf).toBeNull();

    await expect(set({ action: "create", slug: "#Glowfish", name: "Again" })).rejects.toMatchObject({ code: "conflict" });
    await expect(
      set({ action: "create", slug: "fishbowl", name: "Fishbowl", repoUrl: "https://github.com/janedoe/glowfish" }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(set({ action: "create", slug: "bad", name: "Bad", repoUrl: "not a repo" })).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("takes an explicit shelf, a new shelf, or none, and a tag or none", async () => {
    const onShelf = await set({ action: "create", slug: "clients", name: "Client work", shelf: "WRK/CLI", tag: "#Clients" });
    expect(onShelf.project).toMatchObject({ shelf: "WRK/CLI", tag: "clients" });

    const made = await set({
      action: "create",
      slug: "garden",
      name: "Garden",
      newShelf: { section: "LIF", code: "GRD", name: "Garden", description: "The garden project." },
      tag: null,
    });
    expect(made.project).toMatchObject({ shelf: "LIF/GRD", tag: null });
    expect(made.created).toEqual({ shelf: "LIF/GRD", tag: null });

    const bare = await set({ action: "create", slug: "scratch", name: "Scratch", shelf: null, tag: null });
    expect(bare.project).toMatchObject({ shelf: null, tag: null });
  });

  it("renames, archives, and sets repository, shelf, tag and description", async () => {
    await set({ action: "create", slug: "glowfish", name: "Glowfish" });
    expect((await set({ action: "rename", slug: "glowfish", name: "Glowfish App" })).project?.name).toBe("Glowfish App");

    const updated = await set({
      action: "set",
      slug: "glowfish",
      repoUrl: "https://github.com/JaneDoe/glowfish/",
      shelf: "WRK/CLI",
      tag: "#Fish",
      description: "The aquarium tracker.",
    });
    expect(updated.project).toMatchObject({
      repoUrl: "github.com/JaneDoe/glowfish",
      shelf: "WRK/CLI",
      tag: "fish",
      description: "The aquarium tracker.",
    });
    expect(updated.created.tag).toBe("fish");

    const cleared = await set({ action: "set", slug: "glowfish", repoUrl: null, description: null });
    expect(cleared.project).toMatchObject({ repoUrl: null, description: null });

    const archived = await set({ action: "archive", slug: "glowfish" });
    expect(archived.project?.archived).toBe(true);
    expect((await set({ action: "archive", slug: "glowfish", archived: false })).project?.archived).toBe(false);
    expect((await set({ action: "archive", slug: "glowfish", archived: false })).changed).toBe(false);

    await expect(set({ action: "rename", slug: "nobody", name: "Nobody" })).rejects.toMatchObject({ code: "not_found" });
    await expect(set({ action: "set", slug: "glowfish" })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("adds and removes folders through the host, never the silo", async () => {
    const created = await set({ action: "create", slug: "glowfish", name: "Glowfish", folders: [`${FOLDER}/`] });
    expect(created.folders).toEqual([FOLDER]);

    const added = await set({ action: "add_folder", slug: "glowfish", path: WORKTREE });
    expect(added.folders).toEqual([FOLDER, WORKTREE].sort());
    expect((await set({ action: "add_folder", slug: "glowfish", path: WORKTREE })).changed).toBe(false);
    expect(host.localPaths).toEqual([
      { project: "glowfish", path: FOLDER },
      { project: "glowfish", path: WORKTREE },
    ]);

    // Paths stay home: no row in any silo table holds a folder path.
    const text = await siloText(host);
    expect(text).not.toContain("jane.doe");
    expect(text).not.toContain("glowfish-app");
    expect(text).not.toContain("glowfish-worktree");
    // Nor does the audit log.
    expect(JSON.stringify(host.audit)).not.toContain("jane.doe");

    const removed = await set({ action: "remove_folder", path: WORKTREE });
    expect(removed.folders).toEqual([FOLDER]);
    await expect(set({ action: "remove_folder", path: WORKTREE })).rejects.toMatchObject({ code: "not_found" });
  });

  it("keeps a folder in at most one project", async () => {
    await set({ action: "create", slug: "glowfish", name: "Glowfish", folders: [FOLDER] });
    await set({ action: "create", slug: "nightstash", name: "NightStash" });
    await expect(set({ action: "add_folder", slug: "nightstash", path: FOLDER })).rejects.toMatchObject({
      code: "conflict",
      detail: { heldBy: "glowfish" },
    });
    await expect(set({ action: "create", slug: "other", name: "Other", folders: [FOLDER] })).rejects.toMatchObject({
      code: "conflict",
    });
    expect(await host.db.project.count({ where: { slug: "other" } })).toBe(0);
    await expect(set({ action: "add_folder", slug: "glowfish", path: "relative/path" })).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("refuses folder operations when the host keeps no folders, and everything else still works", async () => {
    const bare = await testHost({ now: NOW, noLocalPaths: true });
    try {
      const invoke = (input: Record<string, unknown>) => bare.invoke<SetProjectsResult>("memory.set_projects", input);
      const created = await invoke({ action: "create", slug: "glowfish", name: "Glowfish" });
      expect(created.folders).toBeNull();
      await expect(invoke({ action: "add_folder", slug: "glowfish", path: FOLDER })).rejects.toMatchObject({
        code: "unavailable",
        message: expect.stringContaining("localPaths"),
      });
      await expect(invoke({ action: "remove_folder", path: FOLDER })).rejects.toMatchObject({ code: "unavailable" });
      await expect(invoke({ action: "create", slug: "other", name: "Other", folders: [FOLDER] })).rejects.toMatchObject({
        code: "unavailable",
      });
      expect(await bare.db.project.count({ where: { slug: "other" } })).toBe(0);
      expect((await invoke({ action: "rename", slug: "glowfish", name: "Glowfish App" })).project?.name).toBe("Glowfish App");
    } finally {
      await bare.close();
    }
  });

  it("refuses while incognito is on", async () => {
    host.setIncognito(true);
    await expect(set({ action: "create", slug: "glowfish", name: "Glowfish", folders: [FOLDER] })).rejects.toMatchObject({
      code: "refused",
    });
    expect(host.localPaths).toEqual([]);
    expect(await host.db.project.count()).toBe(0);
  });
});
