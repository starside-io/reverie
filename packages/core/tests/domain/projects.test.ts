import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  codeCandidates,
  createProject,
  projectView,
  proposeProjectHome,
  updateProject,
} from "../../src/domain/projects.js";
import type { Silo } from "../../src/storage/client.js";
import { openLibrary } from "./library.js";

describe("projects", () => {
  let db: Silo;

  beforeEach(async () => {
    db = await openLibrary();
  });
  afterEach(async () => {
    await db.$disconnect();
  });

  it("reads shelf codes from the name, first three letters first", () => {
    const codes = codeCandidates("Glowfish");
    expect(codes[0]).toBe("GLO");
    expect(codes[1]).toBe("GLO".slice(0, 1) + "LW");
    expect(new Set(codes).size).toBe(codes.length);
    expect(codeCandidates("42")[0]).toBe("PAA");
  });

  it("proposes an existing shelf by name, else the first free code", async () => {
    expect((await proposeProjectHome(db, { slug: "nightstash", name: "NightStash" })).shelf).toEqual({
      existing: "WRK/NST",
      create: null,
    });
    await db.shelf.create({
      data: {
        sectionId: (await db.section.findUniqueOrThrow({ where: { code: "WRK" } })).id,
        code: "GLO",
        name: "Gloves",
        description: "Gloves.",
        order: 9,
      },
    });
    const proposal = await proposeProjectHome(db, { slug: "glowfish", name: "Glowfish" });
    expect(proposal.shelf?.create?.code).toBe("GLW");
    expect(proposal).toMatchObject({ tag: "glowfish", tagExists: false });
    expect((await proposeProjectHome(db, { slug: "x", name: "X" }, "ZZZ")).shelf).toBeNull();
  });

  it("creates with a new shelf and a tag, refusing a second slug or repository", async () => {
    const row = await createProject(db, {
      slug: "#Glowfish",
      name: "Glowfish",
      repoUrl: "https://github.com/janedoe/glowfish.git",
      newShelf: { section: "WRK", code: "GLO", name: "Glowfish", description: "Glowfish." },
      tag: "Glowfish",
    });
    expect(projectView(row)).toEqual({
      slug: "glowfish",
      name: "Glowfish",
      repoUrl: "github.com/janedoe/glowfish",
      shelf: "WRK/GLO",
      tag: "glowfish",
      description: null,
      archived: false,
    });
    await expect(createProject(db, { slug: "glowfish", name: "Again" })).rejects.toMatchObject({ code: "conflict" });
    await expect(
      createProject(db, { slug: "other", name: "Other", repoUrl: "git@github.com:janedoe/glowfish.git" }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      createProject(db, { slug: "both", name: "Both", shelf: "WRK/NST", newShelf: { section: "WRK", code: "BTH", name: "B", description: "B." } }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("updates only what changed, and null clears", async () => {
    await createProject(db, { slug: "glowfish", name: "Glowfish", shelf: "WRK/CLI", tag: "fish" });
    const same = await updateProject(db, "glowfish", { name: "Glowfish", shelf: "WRK/CLI" });
    expect(same.changed).toBe(false);
    const cleared = await updateProject(db, "glowfish", { shelf: null, tag: null, archived: true });
    expect(projectView(cleared.project)).toMatchObject({ shelf: null, tag: null, archived: true });
    await expect(updateProject(db, "nobody", { name: "Nobody" })).rejects.toMatchObject({ code: "not_found" });
  });
});
