import { afterEach, describe, expect, it } from "vitest";

import type { DecideResult } from "../../../src/tools/confirm/decide.js";
import type { DraftContextResult } from "../../../src/tools/drafting/draft-context.js";
import type { ProposeDraftResult } from "../../../src/tools/drafting/propose-draft.js";
import type { CoreResult } from "../../../src/tools/read/core.js";
import {
  CONSOLIDATION_LAST_AT_KEY,
  CONSOLIDATION_SESSIONS_KEY,
  OWNER_LINE_KEY,
} from "../../../src/tools/shared/host-values.js";
import type { OwnerLineResult } from "../../../src/tools/write/pin.js";
import type { RememberResult } from "../../../src/tools/write/remember.js";
import { testHost, type TestHost, type TestHostOptions } from "../../test-host.js";

/**
 * The core block's owner line and its "consolidation due" status, both kept
 * in the host's settings values (SettingsPort.values), never in the silo.
 * All data is invented.
 */

const NOW = new Date("2026-12-27T10:00:00.000Z");
const LINE = "Jane Doe, a carpenter in Porto who keeps notes for her workshop.";

describe("the owner line", () => {
  let host: TestHost;

  async function open(options: TestHostOptions = {}) {
    host = await testHost({ now: NOW, session: { id: "session-1" }, ...options });
    return host;
  }
  afterEach(async () => {
    await host.close();
  });

  const core = () => host.invoke<CoreResult>("memory.core", {});

  it("is empty until set, then opens the block, from the host's settings values", async () => {
    await open();
    expect((await core()).included.map((item) => item.slot)).not.toContain("owner");

    const set = await host.invoke<OwnerLineResult>("memory.pin", { ownerLine: LINE });
    expect(set).toEqual({ ownerLine: LINE, changed: true });
    expect(host.values.get(OWNER_LINE_KEY)).toBe(LINE);
    expect(await host.db.memory.count()).toBe(0);

    const block = await core();
    expect(block.included[0]).toEqual({ slot: "owner", ref: "owner" });
    expect(block.text.startsWith(`## Owner\n${LINE}`)).toBe(true);

    expect(await host.invoke<OwnerLineResult>("memory.pin", { ownerLine: LINE })).toEqual({ ownerLine: LINE, changed: false });
    expect(await host.invoke<OwnerLineResult>("memory.pin", { ownerLine: null })).toEqual({ ownerLine: null, changed: true });
    expect((await core()).text).not.toContain(LINE);
  });

  it("keeps the block byte-stable for the same library and the same settings", async () => {
    await open();
    await host.invoke("memory.remember", { kind: "fact", shelf: "LIF/HOM", body: "The spare key is with John Doe." });
    await host.invoke("memory.pin", { ownerLine: LINE });
    const first = (await core()).text;
    const later = (await host.invoke<CoreResult>("memory.core", {}, { now: new Date("2026-12-28T09:00:00.000Z") })).text;
    expect(later).toBe(first);
    // The status slot stays last.
    expect(first.trimEnd().split("\n").slice(-3)[0]).toBe("## Status");
  });

  it("is refused as unavailable on a host that keeps no settings values", async () => {
    await open({ noValues: true });
    await expect(host.invoke("memory.pin", { ownerLine: LINE })).rejects.toMatchObject({
      code: "unavailable",
      detail: { values: false },
    });
    expect((await core()).included.map((item) => item.slot)).not.toContain("owner");
  });

  it("runs discipline, takes one of call or ownerLine, and is refused while incognito", async () => {
    await open();
    await expect(
      host.invoke("memory.pin", { ownerLine: "Jane Doe. API key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH" }),
    ).rejects.toMatchObject({ code: "refused" });
    await expect(host.invoke("memory.pin", { ownerLine: "Jane Doe, back from Porto yesterday." })).rejects.toMatchObject({
      code: "refused",
    });
    const written = await host.invoke<RememberResult>("memory.remember", { kind: "fact", body: "Lives in Porto." });
    await expect(host.invoke("memory.pin", { call: written.memory.call, ownerLine: LINE })).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(host.invoke("memory.pin", {})).rejects.toMatchObject({ code: "invalid_input" });
    host.setIncognito(true);
    await expect(host.invoke("memory.pin", { ownerLine: LINE })).rejects.toMatchObject({ code: "refused", detail: { incognito: true } });
    expect(host.values.has(OWNER_LINE_KEY)).toBe(false);
  });

  it("the core drafting job proposes a wording, and confirming it with decide lands it in settings", async () => {
    await open();
    await host.invoke("memory.pin", { ownerLine: "Jane Doe." });
    const context = await host.invoke<DraftContextResult>("memory.draft_context", { job: "core" });
    expect(context.material).toMatchObject({ ownerLine: "Jane Doe." });
    expect(context.prompt).toContain("Owner line now: Jane Doe.");

    const proposed = await host.invoke<ProposeDraftResult>("memory.propose_draft", {
      target: context.target,
      draft: { ownerLine: { text: LINE, reason: "Says what she does and where." } },
    });
    expect(proposed.rejected).toEqual([]);
    expect(proposed.queued).toEqual([expect.objectContaining({ tool: "memory.pin" })]);
    expect(host.proposals[0]?.payload).toMatchObject({ ownerLine: LINE, draft: { job: "core" } });
    // Proposing writes nothing.
    expect(host.values.get(OWNER_LINE_KEY)).toBe("Jane Doe.");

    const decided = await host.invoke<DecideResult>("memory.decide", {
      proposalId: proposed.queued[0]!.id,
      decision: "confirm",
      confirmedByUser: true,
    });
    expect(decided).toMatchObject({ state: "confirmed", tool: "memory.pin", committed: null, result: { ownerLine: LINE, changed: true } });
    expect(host.values.get(OWNER_LINE_KEY)).toBe(LINE);
    expect((await core()).text).toContain(LINE);
  });

  it("refuses a drafted owner line that fails discipline or changes nothing, after the pins", async () => {
    await open();
    await host.invoke("memory.pin", { ownerLine: LINE });
    const context = await host.invoke<DraftContextResult>("memory.draft_context", { job: "core" });
    const same = await host.invoke<ProposeDraftResult>("memory.propose_draft", {
      target: context.target,
      draft: { ownerLine: { text: LINE, reason: "Same." } },
    });
    expect(same.rejected.map((r) => [r.index, r.code])).toEqual([[0, "unchanged"]]);
    const dated = await host.invoke<ProposeDraftResult>("memory.propose_draft", {
      target: context.target,
      draft: { ownerLine: { text: "Jane Doe, who moved to Porto last week.", reason: "Fresh." } },
    });
    expect(dated.rejected.map((r) => [r.index, r.code])).toEqual([[0, "discipline"]]);
    expect(host.proposals).toEqual([]);
  });
});

describe("consolidation due", () => {
  let host: TestHost;

  afterEach(async () => {
    await host.close();
  });

  const due = async (now = NOW) =>
    (await host.invoke<CoreResult>("memory.core", {}, { now })).text.includes("Consolidation due: yes");

  it("is due after consolidateEvery.sessions ended sessions, counted once each", async () => {
    host = await testHost({ now: NOW, config: { consolidateEvery: { sessions: 3, days: 7 } } });
    expect(await due()).toBe(false);
    for (const id of ["s-1", "s-2", "s-2"]) await host.api.deliver("host.session.ended", { sessionId: id });
    expect(host.values.get(CONSOLIDATION_SESSIONS_KEY)).toBe(2);
    expect(await due()).toBe(false);
    await host.api.deliver("host.session.ended", { sessionId: "s-3" });
    expect(await due()).toBe(true);
  });

  it("restarts when the consolidate job queues proposals, and is due again after consolidateEvery.days", async () => {
    host = await testHost({ now: NOW, config: { consolidateEvery: { sessions: 2, days: 7 } } });
    for (const id of ["s-1", "s-2"]) await host.api.deliver("host.session.ended", { sessionId: id });
    expect(await due()).toBe(true);

    const a = await host.invoke<RememberResult>("memory.remember", {
      kind: "preference",
      shelf: "LIF/HOM",
      occurredOn: "2026-11-01",
      body: "Prefers oat milk in coffee.",
    });
    const b = await host.invoke<RememberResult>("memory.remember", {
      kind: "preference",
      shelf: "LIF/HOM",
      occurredOn: "2026-11-02",
      body: "Likes oat milk in coffee, every morning.",
    });
    const context = await host.invoke<DraftContextResult>("memory.draft_context", { job: "consolidate", shelf: "LIF/HOM" });
    await host.invoke("memory.propose_draft", {
      target: context.target,
      draft: { actions: [{ action: "merge", survivor: a.memory.call, absorbed: b.memory.call, reason: "Same preference." }] },
    });
    expect(host.values.get(CONSOLIDATION_LAST_AT_KEY)).toBe(NOW.toISOString());
    expect(host.values.get(CONSOLIDATION_SESSIONS_KEY)).toBe(0);

    expect(await due()).toBe(false);
    expect(await due(new Date("2027-01-02T10:00:00.000Z"))).toBe(false);
    expect(await due(new Date("2027-01-03T10:00:00.000Z"))).toBe(true);
  });

  it("is never due on a host that keeps no settings values", async () => {
    host = await testHost({ now: NOW, noValues: true, config: { consolidateEvery: { sessions: 1, days: 1 } } });
    expect(await host.api.deliver("host.session.ended", { sessionId: "s-1" })).toMatchObject({
      handled: false,
      reason: "no_settings_values",
    });
    expect(await due()).toBe(false);
  });
});
