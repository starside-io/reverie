import { afterEach, describe, expect, it } from "vitest";

import { registry } from "../../src/tools/index.js";
import type { CoreResult } from "../../src/tools/read/core.js";
import type { RecallResult } from "../../src/tools/read/recall.js";
import type { SearchResult } from "../../src/tools/read/search.js";
import type { RememberResult } from "../../src/tools/write/remember.js";
import type { TestHost } from "../test-host.js";
import { candidate, draft, gateHost, rowCounts, runEveryTool, SESSION_DATE, siloText, turns } from "./harness.js";

/**
 * Gate: scope isolation, incognito, sensitive by ask only. The design
 * carries this row over without restating it; the starting reading tested
 * here: a recall (and the core block) in one project, agent or session
 * never returns another's scoped memories; incognito writes nothing, not
 * even a RecallLog row or a recall count, while every read still answers;
 * a sensitive category is refused without an explicit ask.
 */

const NST = { slug: "nightstash", folder: "/work/nightstash", remote: "git@github.com:jane-doe/nightstash.git" };
const FLW = { slug: "fellowship", folder: "/work/fellowship", remote: "git@github.com:jane-doe/fellowship.git" };

describe("scope isolation", () => {
  let host: TestHost;
  afterEach(async () => {
    await host.close();
  });

  const at = (session: Record<string, string>) => ({ session });
  const recall = async (query: string, session: Record<string, string>) =>
    (await host.invoke<RecallResult>("memory.recall", { query }, at(session))).items.map((item) => item.call);

  it("a project memory is recalled in its project only, never in another or with no project", async () => {
    host = await gateHost({
      localPaths: [
        { project: NST.slug, path: NST.folder },
        { project: FLW.slug, path: FLW.folder },
      ],
    });
    for (const project of [NST, FLW]) {
      await host.invoke("memory.set_projects", { action: "create", slug: project.slug, name: project.slug, repoUrl: project.remote, shelf: null });
    }
    const inNst = { id: "s1", folder: `${NST.folder}/src` };
    const inFlw = { id: "s2", folder: FLW.folder };
    const made = await host.invoke<RememberResult>(
      "memory.remember",
      { kind: "fact", shelf: "WRK/NST", scope: "project", body: "The pricing page uses the annual plan first." },
      at(inNst),
    );
    expect(made.memory.scopeRef).toBe(NST.slug);
    await host.invoke("memory.pin", { call: made.memory.call, pinned: true }, at(inNst));

    expect(await recall("pricing annual plan", inNst)).toEqual([made.memory.call]);
    expect(await recall("pricing annual plan", { id: "s3", folder: "/elsewhere", gitRemote: NST.remote })).toEqual([made.memory.call]);
    expect(await recall("pricing annual plan", inFlw)).toEqual([]);
    expect(await recall("pricing annual plan", { id: "s4" })).toEqual([]);

    const coreFlw = await host.invoke<CoreResult>("memory.core", {}, at(inFlw));
    expect(coreFlw.text).not.toContain("annual plan");
    const coreNst = await host.invoke<CoreResult>("memory.core", {}, at(inNst));
    expect(coreNst.text).toContain("annual plan");
  });

  it("an agent memory is recalled by that agent only, and a session memory in that session only", async () => {
    host = await gateHost();
    const agent = await host.invoke<RememberResult>(
      "memory.remember",
      { kind: "preference", shelf: "CRF/HOW", scope: "agent", body: "The reviewer agent leaves one comment per file." },
      at({ id: "s1", agent: "reviewer" }),
    );
    const session = await host.invoke<RememberResult>(
      "memory.remember",
      { kind: "fact", shelf: "CRF/TLG", scope: "session", body: "This session pins the compiler to version five." },
      at({ id: "s1" }),
    );
    expect(await recall("reviewer comment per file", { id: "s9", agent: "reviewer" })).toEqual([agent.memory.call]);
    expect(await recall("reviewer comment per file", { id: "s9", agent: "writer" })).toEqual([]);
    expect(await recall("reviewer comment per file", { id: "s9" })).toEqual([]);
    expect(await recall("compiler version five", { id: "s1" })).toEqual([session.memory.call]);
    expect(await recall("compiler version five", { id: "s2" })).toEqual([]);
  });
});

describe("incognito", () => {
  let host: TestHost;
  afterEach(async () => {
    await host.close();
  });

  it("every write and needs-ok tool refuses with the reason, and nothing is written", async () => {
    host = await gateHost();
    const { calls } = await runEveryTool(host);
    const before = await rowCounts(host);
    const silo = await siloText(host);
    const proposals = host.proposals.length;
    const events = host.events.length;
    host.setIncognito(true);

    const call = calls.christmas;
    const ok = { confirmedByUser: true };
    const writes: Record<string, Record<string, unknown>> = {
      "memory.remember": { kind: "fact", body: "Prefers green tea in the afternoon." },
      "memory.update": { call, body: "Hosted Christmas for six." },
      "memory.supersede": { call, body: "Hosted Christmas for six." },
      "memory.touch": { call },
      "memory.pin": { call, pinned: true },
      "memory.retire": { call },
      "memory.shelve": { action: "move", call, shelf: "LIF/HOM" },
      "memory.set_tags": { action: "memory", call, attach: ["holiday"] },
      "memory.set_shelves": { action: "create_shelf", section: "LIF", code: "PET", name: "Pets", description: "The cat." },
      "memory.set_projects": { action: "create", slug: "atlas", name: "Atlas" },
      "memory.link": { from: call, to: calls.key, relation: "elaborates" },
      "memory.link_occasion": { call, occasion: "module://people/event/e_2" },
      "memory.add_source": { call, quote: "We were six." },
      "memory.session_note": { body: "A note while paused." },
      "memory.propose_draft": {
        target: { job: "extract", material: turns("Prefers green tea in the afternoon."), sessionDate: SESSION_DATE },
        draft: { candidates: [candidate({ body: "Prefers green tea in the afternoon.", quote: "Prefers green tea in the afternoon." })] },
      },
      "memory.forget": { call, ...ok },
      "memory.redact": { call, ...ok },
      "memory.promote_procedure": { body: "Reply briefly.", why: "Time.", howToApply: "Always.", ...ok },
      "memory.merge": { survivor: call, absorbed: calls.key, ...ok },
      "memory.import": { snapshot: {}, mode: "merge", ...ok },
      "memory.decide": { proposalId: "proposal-1", decision: "reject", ...ok },
    };
    const writing = registry.tools.filter((tool) => tool.kind !== "read").map((tool) => tool.name).sort();
    expect(Object.keys(writes).sort()).toEqual(writing);
    for (const [name, input] of Object.entries(writes)) {
      const error = await host.invoke(name, input).catch((caught: unknown) => caught);
      expect(error, name).toMatchObject({ code: "refused", detail: { incognito: true } });
      expect(String((error as Error).message), name).toContain("Incognito");
    }

    // Every read still answers.
    const reads: Record<string, Record<string, unknown>> = {
      "memory.recall": { query: "oven pizza" },
      "memory.browse": { shelf: "LIF/GTH" },
      "memory.get": { call },
      "memory.search": { query: "pizza" },
      "memory.related": { call },
      "memory.about": { person: "Jane Doe" },
      "memory.shelves": {},
      "memory.tags": {},
      "memory.projects": {},
      "memory.core": {},
      "memory.history": { call },
      "memory.explain": { call },
      "memory.sources": { call },
      "memory.stale": {},
      "memory.conflicts": {},
      "memory.stats": {},
      "memory.export": {},
      "memory.review": {},
      "memory.fs_view": {},
      "memory.draft_context": { job: "extract", material: turns("Prefers green tea."), sessionDate: SESSION_DATE },
    };
    expect(Object.keys(reads).sort()).toEqual(registry.tools.filter((tool) => tool.kind === "read").map((tool) => tool.name).sort());
    for (const [name, input] of Object.entries(reads)) await expect(host.invoke(name, input), name).resolves.toBeDefined();

    const recalled = await host.invoke<RecallResult>("memory.recall", { query: "oven pizza" });
    expect(recalled).toMatchObject({ sufficient: true, recallId: null });

    expect(await rowCounts(host)).toEqual(before);
    expect(await siloText(host)).toBe(silo);
    expect(host.proposals).toHaveLength(proposals);
    expect(host.events).toHaveLength(events);
  });

  it("recall while incognito writes no RecallLog row and counts no recall", async () => {
    host = await gateHost();
    const made = await host.invoke<RememberResult>("memory.remember", { kind: "fact", shelf: "LIF/HOM", body: "The spare key hangs by the side door." });
    host.setIncognito(true);
    const result = await host.invoke<RecallResult>("memory.recall", { query: "spare key" });
    expect(result.items.map((item) => item.call)).toEqual([made.memory.call]);
    expect(await host.db.recallLog.count()).toBe(0);
    const row = await host.db.memory.findUniqueOrThrow({ where: { id: made.memory.id } });
    expect(row).toMatchObject({ recallCount: 0, lastRecalledAt: null });

    host.setIncognito(false);
    await host.invoke("memory.recall", { query: "spare key" });
    expect(await host.db.recallLog.count()).toBe(1);
  });
});

describe("sensitive by ask only", () => {
  let host: TestHost;
  afterEach(async () => {
    await host.close();
  });

  const SENSITIVE = [
    "Diagnosed with asthma in 2019.",
    "The mortgage is with the bank on Elm Street.",
    "Votes in the town election every spring.",
    "Goes to church on Sunday mornings.",
  ];

  it.each(SENSITIVE)("refuses %j at the direct door without an explicit ask, and keeps it with one", async (body) => {
    host = await gateHost();
    const refused = { code: "refused", detail: { findings: expect.arrayContaining([expect.objectContaining({ check: "sensitive" })]) } };
    await expect(host.invoke("memory.remember", { kind: "fact", shelf: "LIF/HLT", body })).rejects.toMatchObject(refused);
    const kept = await host.invoke<RememberResult>("memory.remember", { kind: "fact", shelf: "LIF/HLT", body, explicitAsk: true });
    expect(kept.memory.body).toBe(body);

    const plain = await host.invoke<RememberResult>("memory.remember", { kind: "fact", shelf: "LIF/HOM", body: "The hall light is on a timer." });
    await expect(host.invoke("memory.update", { call: plain.memory.call, body })).rejects.toMatchObject(refused);
    await expect(host.invoke("memory.supersede", { call: plain.memory.call, body })).rejects.toMatchObject(refused);
  });

  it("a drafted ask counts only when the owner made it in their own words", async () => {
    host = await gateHost();
    const body = "Diagnosed with asthma in 2019.";
    const asked = await draft(
      host,
      { job: "extract", material: turns(`Please remember this: ${body}`), sessionDate: SESSION_DATE },
      { candidates: [candidate({ body, explicitAsk: true, quote: body })] },
    );
    expect(asked.queued).toHaveLength(1);

    const fromModel = await draft(
      host,
      { job: "extract", material: turns("How are you?", [{ role: "assistant", text: `I recall: ${body}` }]), sessionDate: SESSION_DATE },
      { candidates: [candidate({ body, explicitAsk: true, quote: body })] },
    );
    expect(fromModel.queued).toEqual([]);
    expect(fromModel.rejected[0]).toMatchObject({ code: "discipline" });

    const notAsked = await draft(
      host,
      { job: "extract", material: turns(body), sessionDate: SESSION_DATE },
      { candidates: [candidate({ body, quote: body })] },
    );
    expect(notAsked.queued).toEqual([]);
    expect((await host.invoke<SearchResult>("memory.search", { query: "asthma" })).items).toEqual([]);
  });
});
