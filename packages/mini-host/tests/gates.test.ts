import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_CONFIG, type ModuleConfig } from "@reverie/core/config/index.js";

import {
  NOW,
  SCRIPT_STRINGS,
  SCRIPT_TEXT,
  fsViewText,
  rowCounts,
  runEveryTool,
  siloText,
} from "../../core/tests/gates/harness.js";
import type { TestHost } from "../../core/tests/test-host.js";
import type { MiniHost } from "../src/host.js";
import { throwawayHost } from "./harness.js";

/**
 * Core's gates, a meaningful subset, against the real mini-host ports
 * (docs/SPEC.md section 16: gates run against the mini-host). Core's own gate
 * suite runs them on its in-memory test host; here the same scripted session
 * and the same checks run on host.db, the real review queue, the real bus,
 * the real settings port and a refs port that answers no people. Nothing in
 * core's gate files is edited: their harness is imported as is.
 *
 * The adapter below gives core's harness the shape it expects. What it reads
 * (invoke, db) is real; the in-memory records the test host keeps (audit,
 * events, proposals) are left empty, because the real ones are in host.db and
 * these tests read them from there.
 */

const SESSION = { id: "session-1" };

function asTestHost(host: MiniHost): TestHost {
  let config: ModuleConfig = host.config();
  return {
    api: host.api,
    ports: host.ports,
    db: host.silo,
    audit: [],
    events: [],
    proposals: [],
    localPaths: [],
    values: new Map(),
    embedCalls: [],
    get config() {
      return config;
    },
    set config(next: ModuleConfig) {
      config = next;
      host.store.writeSetting("module.config", next);
    },
    session: SESSION,
    now: NOW,
    invoke: async <T>(name: string, input: unknown = {}, options = {}) =>
      (await host.api.invoke(name, input, { now: NOW, session: SESSION, ...options })) as T,
    primeRef: () => {
      throw new Error("The mini-host's refs port answers no people: there is nothing to prime.");
    },
    primePeople: () => {
      throw new Error("The mini-host's refs port answers no people: there is nothing to prime.");
    },
    setIncognito: (on) => {
      config = { ...config, incognito: on };
      host.store.writeSetting("module.config", config);
    },
    close: () => host.close(),
  };
}

let open: MiniHost[] = [];

async function gateHost(): Promise<{ mini: MiniHost; host: TestHost }> {
  const mini = await throwawayHost();
  open.push(mini);
  return { mini, host: asTestHost(mini) };
}

afterEach(async () => {
  for (const host of open.splice(0)) await host.close();
});

/** Every row of the host.db tables that must hold no text: audit and the event feed. */
function hostLogText(mini: MiniHost): string {
  return JSON.stringify({
    audit: mini.host.db.prepare(`SELECT * FROM "audit"`).all(),
    events: mini.host.db.prepare(`SELECT * FROM "event"`).all(),
  });
}

describe("gates on the real mini-host", () => {
  it("every one of the 41 tools runs on the real ports, with the people module absent", async () => {
    const { mini, host } = await gateHost();
    const script = await runEveryTool(host);
    expect(new Set(script.called).size).toBe(41);
    expect([...new Set(script.called)].sort()).toEqual(mini.api.tools.map((tool) => tool.name).sort());

    // Every call left one audit line in host.db, and the review queue there
    // holds the proposal the script confirmed.
    expect(mini.store.listAudit(1000).length).toBeGreaterThanOrEqual(script.called.length);
    expect(mini.store.listProposals("confirmed")).toHaveLength(1);

    // Works without Fellowship: the people ref renders unavailable, and nothing failed for it.
    const christmas = (await host.invoke("memory.get", { call: script.calls["christmas"] })) as {
      memory: { attendees: Array<{ status?: string; label: string }> };
    };
    expect(JSON.stringify(christmas)).toContain("unavailable");
  });

  it("no text in logs: host.db's audit lines and event feed hold ids and counts only", async () => {
    const { mini, host } = await gateHost();
    await runEveryTool(host);
    const logs = hostLogText(mini);
    for (const text of SCRIPT_STRINGS) expect(logs, text).not.toContain(text);
    for (const word of ["pizza", "kettle", "ladder", "oat milk", "imperative"]) {
      expect(logs.toLowerCase(), word).not.toContain(word);
    }

    // RecallLog rows in the silo hold no query text either.
    const recallLog = JSON.stringify(await mini.silo.recallLog.findMany());
    expect(recallLog).not.toContain(SCRIPT_TEXT.recallQuery);
  });

  it("forget is real: no row, no FTS hit, no version text, absent from export and the mirror", async () => {
    const { host } = await gateHost();
    const body = "Lent the ladder to the neighbours on Elm Street after the storm.";
    const made = (await host.invoke("memory.remember", { kind: "fact", shelf: "LIF/HOM", body })) as {
      memory: { call: string };
    };
    await host.invoke("memory.update", { call: made.memory.call, body: `${body} Back in January.` });
    expect(await siloText(host)).toContain("Elm Street");

    await host.invoke("memory.forget", { call: made.memory.call, confirmedByUser: true });

    expect(await siloText(host)).not.toContain("Elm Street");
    expect(await fsViewText(host)).not.toContain("Elm Street");
    expect(JSON.stringify(await host.invoke("memory.export", {}))).not.toContain("Elm Street");
    expect(await host.invoke("memory.search", { query: "ladder" })).toMatchObject({ items: [] });
    expect(await host.invoke("memory.recall", { query: "ladder neighbours" })).toEqual({ items: [], sufficient: false });
  });

  it("abstention: an empty library and a query nothing matches both return sufficient false and no items", async () => {
    const { host } = await gateHost();
    expect(await host.invoke("memory.recall", { query: "christmas" })).toEqual({ items: [], sufficient: false });
    await host.invoke("memory.remember", { kind: "fact", shelf: "LIF/HOM", body: "Prefers oat milk in coffee." });
    expect(await host.invoke("memory.recall", { query: "submarine telescope" })).toEqual({
      items: [],
      sufficient: false,
    });
  });

  it("incognito writes nothing, in the silo or in the review queue, and reads still answer", async () => {
    const { mini, host } = await gateHost();
    host.setIncognito(true);
    const before = await rowCounts(host);

    await expect(
      host.invoke("memory.remember", { kind: "fact", shelf: "LIF/HOM", body: "Prefers oat milk in coffee." }),
    ).rejects.toMatchObject({ code: "refused" });
    await expect(host.invoke("memory.session_note", { body: SCRIPT_TEXT.note })).rejects.toMatchObject({
      code: "refused",
    });

    expect(await rowCounts(host)).toEqual(before);
    expect(mini.store.listProposals("all")).toEqual([]);
    expect(mini.store.listEvents()).toEqual([]);
    expect(await host.invoke("memory.shelves", {})).toBeTruthy();
    // The refusal is audited, without its text.
    expect(mini.store.listAudit().map((entry) => entry.detail)).toContainEqual({ refused: "incognito" });
  });

  it("carried over: the silo opens with foreign keys on and WAL", async () => {
    const { mini } = await gateHost();
    const [keys] = await mini.silo.$queryRawUnsafe<Array<{ foreign_keys: bigint | number }>>("PRAGMA foreign_keys");
    const [journal] = await mini.silo.$queryRawUnsafe<Array<{ journal_mode: string }>>("PRAGMA journal_mode");
    expect(Number(keys?.foreign_keys)).toBe(1);
    expect(journal?.journal_mode).toBe("wal");
    expect(mini.config()).toEqual(DEFAULT_CONFIG);
  });
});
