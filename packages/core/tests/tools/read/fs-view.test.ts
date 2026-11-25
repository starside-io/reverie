import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { retireMemory } from "../../../src/domain/memories.js";
import { RECALL_NOTICE } from "../../../src/domain/recall/frame.js";
import type { FsViewResult } from "../../../src/tools/read/fs-view.js";
import { resolveVirtualPath } from "../../../src/tools/shared/read-fs-path.js";
import { ToolError } from "../../../src/tools/registry.js";
import { PEOPLE, testHost, type TestHost } from "../../test-host.js";
import { NOW, seed } from "./fixtures.js";

type Dir = Extract<FsViewResult, { type: "directory" }>;
type File = Extract<FsViewResult, { type: "file" }>;

describe("memory.fs_view", () => {
  let host: TestHost;

  beforeEach(async () => {
    host = await testHost({ now: NOW });
  });
  afterEach(async () => {
    await host.close();
  });

  async function shelf() {
    const second = await seed(host, { title: "Christmas lunch", body: "Lunch with John Doe.", tags: ["christmas"] });
    const first = await seed(host, { title: "Party prep", body: "Bought lights.", occurredOn: "2026-12-20" });
    const third = await seed(host, {
      title: "Boxing Day",
      body: "A walk with Sam Rivera.",
      occurredOn: "2026-12-26",
      why: "It was sunny.",
      refs: [
        { role: "attendee", uri: PEOPLE.sam.uri, label: "Sam Rivera" },
        { role: "attendee", label: "Jane Doe" },
      ],
    });
    return { first, second, third };
  }

  it("lists sections by name at the root, in library order", async () => {
    const root = await host.invoke<Dir>("memory.fs_view", { path: "/memories" });
    expect(root.type).toBe("directory");
    expect(root.entries.map((entry) => entry.name)).toEqual(["Work", "Life", "Craft", "Reference", "Front desk"]);
    expect(root.entries[1]).toEqual({ name: "Life", path: "/memories/Life", type: "directory" });
    expect(root.text.split("\n")[0]).toBe("Work/");
    expect(await host.invoke("memory.fs_view", {})).toEqual(root);
  });

  it("lists a section's shelves, and a shelf's files in call number order", async () => {
    await shelf();
    const life = await host.invoke<Dir>("memory.fs_view", { path: "/memories/Life" });
    expect(life.entries.map((entry) => entry.name)).toEqual(["Gatherings", "Travel", "Home", "Health"]);

    const gatherings = await host.invoke<Dir>("memory.fs_view", { path: "/memories/Life/Gatherings/" });
    expect(gatherings.entries.map((entry) => entry.name)).toEqual([
      "2026-12-20-001.md",
      "2026-12-24-001.md",
      "2026-12-26-001.md",
    ]);
    expect(gatherings.entries[0]).toEqual({
      name: "2026-12-20-001.md",
      path: "/memories/Life/Gatherings/2026-12-20-001.md",
      type: "file",
    });
    const byCode = await host.invoke<Dir>("memory.fs_view", { path: "/memories/LIF/GTH" });
    expect(byCode.entries).toEqual(gatherings.entries);
    const relative = await host.invoke<Dir>("memory.fs_view", { path: "Life/Gatherings" });
    expect(relative.entries).toEqual(gatherings.entries);
  });

  it("renders one memory as markdown with front matter, people rendered without the people module", async () => {
    await shelf();
    const file = await host.invoke<File>("memory.fs_view", { path: "/memories/Life/Gatherings/2026-12-26-001.md" });
    expect(file.type).toBe("file");
    expect(file.notice).toBe(RECALL_NOTICE);
    expect(file.call).toBe("LIF/GTH/2026-12-26/001");
    expect(file.content).toBe(
      [
        "---",
        'call: "LIF/GTH/2026-12-26/001"',
        'title: "Boxing Day"',
        'kind: "episode"',
        'state: "active"',
        'trust: "stated"',
        'scope: "global"',
        "scopeRef: null",
        'occurredOn: "2026-12-26"',
        "importance: 3",
        "pinned: false",
        "tags: []",
        'attendees: ["Sam Rivera", "Jane Doe"]',
        "occasion: null",
        "supersededBy: null",
        "---",
        "",
        "# Boxing Day",
        "",
        "A walk with Sam Rivera.",
        "",
        "## Why",
        "",
        "It was sunny.",
        "",
      ].join("\n"),
    );
  });

  it("leaves retired entries out of the listing and as files", async () => {
    const { first } = await shelf();
    await retireMemory(host.db, { id: first.id }, { actor: "user", at: NOW });
    const gatherings = await host.invoke<Dir>("memory.fs_view", { path: "/memories/Life/Gatherings" });
    expect(gatherings.entries.map((entry) => entry.name)).not.toContain("2026-12-20-001.md");
    await expect(
      host.invoke("memory.fs_view", { path: "/memories/Life/Gatherings/2026-12-20-001.md" }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("answers not_found for what is not there", async () => {
    await shelf();
    for (const path of [
      "/memories/Nowhere",
      "/memories/Life/Nowhere",
      "/memories/Life/Gatherings/2026-12-24-009.md",
      "/memories/Life/Gatherings/notes.txt",
      "/memories/Life/Travel/2026-12-24-001.md",
      "/memories/Life/Gatherings/2026-12-24-001.md/more",
    ]) {
      await expect(host.invoke("memory.fs_view", { path })).rejects.toMatchObject({ code: "not_found" });
    }
  });

  it("refuses anything that escapes the root: traversal, encoded and look-alike forms", async () => {
    await shelf();
    const escapes = [
      "/etc/passwd",
      "/",
      "/memoriesX",
      "/memories/../etc/passwd",
      "/memories/Life/../../etc",
      "/memories/./Life",
      "../memories",
      "..",
      "/memories/%2e%2e/etc",
      "/memories/%2E%2E/%2E%2E/etc",
      "/memories/%252e%252e/etc",
      "/memories%2f..%2fetc",
      "/memories/Life%2fGatherings",
      "%2fetc%2fpasswd",
      "/memories/Life\\..\\..\\etc",
      "/memories/\u0000/Life",
      "/memories/．．/etc",
      "/memories/%E0%A4%A",
      "/memories/%252525252e%252525252e/x",
    ];
    for (const path of escapes) {
      const error = await host.invoke("memory.fs_view", { path }).catch((e: unknown) => e);
      expect(error, path).toBeInstanceOf(ToolError);
      expect((error as ToolError).code, path).toBe("refused");
    }
  });

  it("resolves paths against the virtual root", () => {
    expect(resolveVirtualPath("/memories")).toEqual([]);
    expect(resolveVirtualPath("/memories//Life///Gatherings/")).toEqual(["Life", "Gatherings"]);
    expect(resolveVirtualPath("Life")).toEqual(["Life"]);
    expect(resolveVirtualPath("/memories/Front%20desk")).toEqual(["Front desk"]);
    expect(() => resolveVirtualPath("/memories/a/../b")).toThrow(ToolError);
  });
});
