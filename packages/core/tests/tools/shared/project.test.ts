import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NO_SESSION } from "../../../src/tools/registry.js";
import {
  longestPathMatch,
  normaliseFolder,
  resolveProjectFor,
} from "../../../src/tools/shared/project.js";
import { testHost, type TestHost } from "../../test-host.js";

describe("normaliseFolder and longestPathMatch", () => {
  it("drops trailing slashes and refuses a relative path", () => {
    expect(normaliseFolder("/work/nightstash/")).toBe("/work/nightstash");
    expect(normaliseFolder("C:\\work\\nightstash\\")).toBe("C:/work/nightstash");
    expect(normaliseFolder("work/nightstash")).toBeNull();
    expect(normaliseFolder("  ")).toBeNull();
  });

  it("matches on whole segments and prefers the longest path", () => {
    const paths = [
      { project: "work", path: "/work" },
      { project: "nightstash", path: "/work/nightstash" },
    ];
    expect(longestPathMatch(paths, "/work/nightstash/app")?.project).toBe("nightstash");
    expect(longestPathMatch(paths, "/work/nightstash-old")?.project).toBe("work");
    expect(longestPathMatch(paths, "/home")).toBeNull();
  });
});

describe("resolveProjectFor (section 4, identifying the project at run time)", () => {
  let host: TestHost;

  beforeEach(async () => {
    host = await testHost();
    await host.db.project.create({
      data: { slug: "nightstash", name: "NightStash", repoUrl: "github.com/owner/nightstash" },
    });
    await host.db.project.create({ data: { slug: "fellowship", name: "Fellowship" } });
  });
  afterEach(async () => {
    await host.close();
  });

  const resolve = (session: { folder?: string; gitRemote?: string }) =>
    resolveProjectFor(host.db, { ...NO_SESSION, ...session }, host.ports.settings.localPaths);

  it("takes the longest registered folder first, over the remote", async () => {
    host.localPaths.push({ project: "fellowship", path: "/work/shared" });
    const result = await resolve({ folder: "/work/shared/app", gitRemote: "git@github.com:owner/nightstash.git" });
    expect(result).toMatchObject({ via: "path", project: { slug: "fellowship" } });
  });

  it("falls back to the normalised remote and offers the folder", async () => {
    const result = await resolve({ folder: "/clones/ns", gitRemote: "https://github.com/owner/nightstash.git" });
    expect(result).toMatchObject({ via: "remote", project: { slug: "nightstash" }, offerPath: "/clones/ns" });
  });

  it("is no project for an unregistered folder, never a guess by name", async () => {
    const result = await resolve({ folder: "/work/nightstash" });
    expect(result).toEqual({ via: "none", project: null, offerPath: null });
  });

  it("skips an archived project", async () => {
    await host.db.project.update({ where: { slug: "nightstash" }, data: { archived: true } });
    const result = await resolve({ gitRemote: "github.com/owner/nightstash" });
    expect(result.via).toBe("none");
  });

  it("goes straight to the remote when the host has no folder store", async () => {
    const result = await resolveProjectFor(
      host.db,
      { ...NO_SESSION, folder: "/work/shared", gitRemote: "github.com/owner/nightstash" },
      undefined,
    );
    expect(result).toMatchObject({ via: "remote", project: { slug: "nightstash" } });
  });
});
