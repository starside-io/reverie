import { afterEach, describe, expect, it } from "vitest";

import type { ProjectsResult } from "../../../src/tools/read/projects.js";
import { testHost, type TestHost, type TestHostOptions } from "../../test-host.js";
import { NOW, project, seed } from "./fixtures.js";

describe("memory.projects", () => {
  let host: TestHost;

  async function open(options: TestHostOptions = {}) {
    host = await testHost({ now: NOW, ...options });
    await project(host, "nightstash", { repoUrl: "github.com/jane-doe/nightstash", shelf: "WRK/NST", tag: "nightstash" });
    await project(host, "garden");
    return host;
  }
  afterEach(async () => {
    await host.close();
  });

  it("lists the registry with shelf, tag, memory count and this machine's folders", async () => {
    await open({
      localPaths: [
        { project: "nightstash", path: "/work/nightstash" },
        { project: "nightstash", path: "/work/nightstash-wt/" },
      ],
    });
    await seed(host, { shelf: "WRK/NST", title: "Pricing", body: "Pricing decided." });
    await seed(host, { shelf: "CRF/HOW", title: "Deploys", body: "Deploy on Fridays.", kind: "fact", scope: "project", scopeRef: "nightstash" });
    await seed(host, { shelf: "WRK/NST", title: "Both", body: "On the shelf and scoped.", scope: "project", scopeRef: "nightstash" });

    const result = await host.invoke<ProjectsResult>("memory.projects");
    expect(result.projects.map((entry) => entry.slug)).toEqual(["garden", "nightstash"]);
    expect(result.projects[1]).toEqual({
      slug: "nightstash",
      name: "Nightstash",
      repoUrl: "github.com/jane-doe/nightstash",
      shelf: "WRK/NST",
      tag: "nightstash",
      description: null,
      archived: false,
      memoryCount: 3,
      localPaths: ["/work/nightstash", "/work/nightstash-wt"],
    });
    expect(result.projects[0]).toMatchObject({ shelf: null, tag: null, memoryCount: 0, localPaths: [] });
    expect(result.localPathsAvailable).toBe(true);
    expect(result.current).toBeNull();
  });

  it("says which project the session resolves to", async () => {
    await open({ localPaths: [{ project: "nightstash", path: "/work/nightstash" }] });
    const byPath = await host.invoke<ProjectsResult>("memory.projects", {}, { session: { folder: "/work/nightstash/src" } });
    expect(byPath.current).toEqual({ slug: "nightstash", via: "path" });
    const byRemote = await host.invoke<ProjectsResult>("memory.projects", {}, {
      session: { folder: "/tmp/clone", gitRemote: "git@github.com:jane-doe/nightstash.git" },
    });
    expect(byRemote.current).toEqual({ slug: "nightstash", via: "remote" });
  });

  it("lists no folders when the host keeps none", async () => {
    await open({ noLocalPaths: true });
    const result = await host.invoke<ProjectsResult>("memory.projects");
    expect(result.localPathsAvailable).toBe(false);
    expect(result.projects.every((entry) => entry.localPaths.length === 0)).toBe(true);
  });
});
