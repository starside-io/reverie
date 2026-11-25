import { afterEach, describe, expect, it } from "vitest";

import type { ExportResult } from "../../src/tools/read/export.js";
import type { ProjectsResult } from "../../src/tools/read/projects.js";
import type { RememberResult } from "../../src/tools/write/remember.js";
import { auditStrings, type TestHost } from "../test-host.js";
import { fsViewText, gateHost, siloText } from "./harness.js";

/**
 * Gate: paths stay home. No export, snapshot, mirror or audit line contains
 * a local folder path, and nothing in the silo does. A project round trips
 * by slug and repository alone: on another machine it resolves by its git
 * remote, and its folders are that machine's to register.
 *
 * The mirror is fs_view here; the markdown mirror adapter (M7) is built on it.
 */

const FOLDER = "/Users/janedoe/code/nightstash";
const WORKTREE = "/Users/janedoe/worktrees/nightstash-pricing";
const REMOTE = "git@github.com:jane-doe/nightstash.git";

describe("paths stay home", () => {
  const hosts: TestHost[] = [];
  afterEach(async () => {
    for (const host of hosts.splice(0)) await host.close();
  });
  async function fresh(options: Parameters<typeof gateHost>[0] = {}) {
    const host = await gateHost(options);
    hosts.push(host);
    return host;
  }

  async function project(host: TestHost) {
    await host.invoke("memory.set_projects", {
      action: "create",
      slug: "nightstash",
      name: "NightStash",
      repoUrl: "https://github.com/jane-doe/nightstash",
      shelf: "WRK/NST",
      folders: [FOLDER],
    });
    await host.invoke("memory.set_projects", { action: "add_folder", slug: "nightstash", path: WORKTREE });
    const inFolder = { session: { id: "session-1", folder: `${FOLDER}/packages/core`, gitRemote: REMOTE } };
    const made = await host.invoke<RememberResult>(
      "memory.remember",
      { kind: "fact", shelf: "WRK/NST", scope: "project", body: "Pricing goes up in 2027-03." },
      inFolder,
    );
    await host.invoke("memory.recall", { query: "pricing" }, inFolder);
    await host.invoke("memory.core", {}, inFolder);
    await host.invoke("memory.session_note", { body: "Looked at the pricing page." }, inFolder);
    return made;
  }

  it("no export, mirror, audit line or silo row holds a folder path", async () => {
    const host = await fresh();
    const made = await project(host);
    expect(made.memory.scopeRef).toBe("nightstash");
    expect(host.localPaths.map((entry) => entry.path).sort()).toEqual([FOLDER, WORKTREE]);

    const { snapshot } = await host.invoke<ExportResult>("memory.export", {});
    const places = {
      export: JSON.stringify(snapshot),
      mirror: await fsViewText(host),
      audit: auditStrings(host).join("\n"),
      silo: await siloText(host),
    };
    for (const [where, text] of Object.entries(places)) {
      expect(text, where).not.toContain("/Users/janedoe");
      expect(text, where).not.toContain("janedoe/code");
    }
    // The registry read answers with this machine's folders, from the host.
    const projects = await host.invoke<ProjectsResult>("memory.projects", {});
    expect(projects.projects[0]?.localPaths.sort()).toEqual([FOLDER, WORKTREE]);
  });

  it("a project round trips by slug and repository, and resolves by git remote on the other machine", async () => {
    const home = await fresh();
    await project(home);
    const { snapshot } = await home.invoke<ExportResult>("memory.export", {});

    const away = await fresh({ seed: false });
    await away.invoke("memory.import", { snapshot, mode: "merge", confirmedByUser: true });
    const projects = await away.invoke<ProjectsResult>("memory.projects", {}, {
      session: { id: "s2", folder: "/home/jdoe/src/ns", gitRemote: REMOTE },
    });
    expect(projects.projects).toEqual([
      expect.objectContaining({ slug: "nightstash", repoUrl: "github.com/jane-doe/nightstash", localPaths: [] }),
    ]);
    expect(away.localPaths).toEqual([]);
    const found = await away.invoke<{ items: unknown[] }>(
      "memory.recall",
      { query: "pricing" },
      { session: { id: "s2", folder: "/home/jdoe/src/ns", gitRemote: REMOTE } },
    );
    expect(found.items).toHaveLength(1);
  });
});
