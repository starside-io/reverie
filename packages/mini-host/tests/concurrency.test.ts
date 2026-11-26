import type { ChildProcess } from "node:child_process";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { storage, tools as coreTools } from "@reverie/core";

import { startMiniHost } from "../src/host.js";
import { firstLine, PACKAGE_ROOT, spawnTs, stopChildren } from "./fixtures/children.js";
import { envFor, filesIn, remember, throwawayDir } from "./harness.js";

/**
 * Several writers on one silo. docs/SPEC.md section 10 says the mini-host
 * serializes writes through one connection, and `reverie serve` takes
 * host.lock; `reverie mcp` takes no lock, so every Claude Code session runs
 * its own MCP process over the same two files, beside a `serve` when one is
 * up. This proves that holds: real processes, all writing at once, the same
 * shelf and day so call number issuance collides, the same memory updated,
 * the same memory forgotten, the same proposal decided, sessions ending
 * together. Every name is invented.
 */

const ROUNDS = 3;
const WORKERS = 5;
const REMEMBERS = 30;
const UPDATES = 10;
const SESSION_ENDS = 15;
const PROPOSALS = 6;
const SHELF = "WRK/NST";
const DAY = "2026-11-20";

interface Outcome {
  op: string;
  ok: boolean;
  ref?: string;
  code?: string;
  message?: string;
}

/** What a busy file looks like when it leaks out as a tool failure. */
const BUSY = /SQLITE_BUSY|database is locked|busy|timed out|Unable to start a transaction|P2028|P1008|SocketTimeout/i;

afterEach(async () => {
  await stopChildren();
});

function finalLine(child: ChildProcess): Promise<{ worker: number; outcomes?: Outcome[]; crashed?: string }> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    let errors = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      errors += chunk.toString();
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
    });
    child.once("exit", () => {
      const lines = buffer.trim().split("\n");
      const last = lines[lines.length - 1];
      try {
        resolve(JSON.parse(last ?? "") as { worker: number; outcomes?: Outcome[] });
      } catch {
        reject(new Error(`A writer exited without a result: ${errors}`));
      }
    });
  });
}

const PLANS = [
  "Sam Rivera wants tomatoes along the south fence of the Elmwood garden.",
  "Jane Doe is building a compost bin from old pallets.",
  "John Doe will paint the shed a pale green.",
  "The rain barrel by the porch needs a new brass tap.",
  "Sam Rivera found the hedge shears in the attic.",
  "Jane Doe plans a herb spiral next to the kitchen door.",
  "John Doe ordered two apple saplings from the Elmwood nursery.",
  "The garden gate latch sticks whenever it has rained overnight.",
];

async function proposeOne(host: Awaited<ReturnType<typeof startMiniHost>>, index: number): Promise<string> {
  const said = PLANS[index] as string;
  const context = (await host.api.invoke("memory.draft_context", {
    job: "extract",
    material: { kind: "turns", turns: [{ role: "user", text: said }] },
    sessionDate: DAY,
  })) as { target: unknown };
  const proposed = (await host.api.invoke("memory.propose_draft", {
    target: context.target,
    draft: {
      candidates: [
        {
          kind: "fact",
          title: `Garden plan ${index}`,
          body: said,
          shelf: "LIF/HOM",
          occurredOn: DAY,
          tags: [],
          people: [],
          occasion: null,
          quote: said,
        },
      ],
    },
  })) as { queued: Array<{ id: string }>; rejected: unknown[] };
  if (!proposed.queued[0]) throw new Error(`The setup proposal was refused: ${JSON.stringify(proposed.rejected)}`);
  return proposed.queued[0].id;
}

async function runOnce(dir: string) {
  const files = filesIn(dir);

  // The parent sets the library up, then steps aside: the writers are the
  // only ones on the files while they run.
  const setup = await startMiniHost({ ...files, env: envFor(dir) });
  const target = await remember(setup, { body: "Jane Doe keeps the spare key under the blue planter.", shelf: "LIF/HOM", occurredOn: DAY });
  const shared = await remember(setup, { body: "John Doe once lent out the tall ladder for the winter.", shelf: "LIF/HOM", occurredOn: DAY });
  const ownBodies = [
    "Sam Rivera parked the red bicycle by the north gate.",
    "Jane Doe booked the ferry to the island for the summer.",
    "John Doe prefers the window seat on long train rides.",
    "The Elmwood library closes early on public holidays.",
    "Sam Rivera keeps a paper map of the coastal trail.",
    "Jane Doe brought homemade lemonade to the picnic.",
  ];
  const own: string[] = [];
  for (let worker = 0; worker < WORKERS; worker += 1) {
    own.push((await remember(setup, { body: ownBodies[worker] as string, shelf: "LIF/TRV", occurredOn: DAY })).memory.call);
  }
  const proposals: string[] = [];
  for (let index = 0; index < PROPOSALS; index += 1) proposals.push(await proposeOne(setup, index));
  const auditBefore = setup.store.listAudit(100_000).length;
  await setup.close();

  const children = Array.from({ length: WORKERS }, (_, worker) => {
    const plan = {
      worker,
      remember: { count: REMEMBERS, shelf: SHELF, occurredOn: DAY },
      update: { call: target.memory.call, count: UPDATES },
      forget: { calls: [shared.memory.call, own[worker]] },
      decide: { proposalIds: proposals },
      sessionEnds: { ids: Array.from({ length: SESSION_ENDS }, (_, index) => `ended-${worker}-${index}`) },
    };
    return spawnTs(join(PACKAGE_ROOT, "tests/fixtures/writer-child.ts"), {
      ...envFor(dir),
      REVERIE_TEST_PLAN: JSON.stringify(plan),
    });
  });
  await Promise.all(children.map((child) => firstLine(child)));
  const results = children.map((child) => finalLine(child));
  for (const child of children) child.stdin?.write("go\n");
  const done = await Promise.all(results);

  const host = await startMiniHost({ ...files, env: envFor(dir) });
  try {
    return { done, host, target, shared, own, proposals, auditBefore };
  } catch (error) {
    await host.close();
    throw error;
  }
}

describe("several MCP processes writing one silo", () => {
  it("loses no write, reissues no number, surfaces no busy file, and keeps search and the queue in step", async () => {
    // Several rounds on fresh files: an interleaving that loses a write
    // shows up in one round and not the next.
    for (let round = 0; round < ROUNDS; round += 1) await checkRound(throwawayDir());
  }, 600_000);
});

async function checkRound(dir: string): Promise<void> {
    const { done, host, target, shared, own, proposals, auditBefore } = await runOnce(dir);
    try {
      for (const result of done) expect(result.crashed, `worker ${result.worker} crashed`).toBeUndefined();
      const outcomes = done.flatMap((result) => result.outcomes ?? []);
      const failures = outcomes.filter((outcome) => !outcome.ok);

      // No busy file reaches a caller as a tool failure.
      const busy = failures.filter((outcome) => BUSY.test(outcome.message ?? ""));
      expect(busy, JSON.stringify(busy.slice(0, 3))).toEqual([]);

      // Every remember landed, each on its own number, 001 upward with no gap.
      const remembered = outcomes.filter((outcome) => outcome.op === "remember");
      expect(remembered).toHaveLength(WORKERS * REMEMBERS);
      expect(remembered.filter((outcome) => !outcome.ok)).toEqual([]);
      const calls = remembered.map((outcome) => outcome.ref as string).sort();
      expect(new Set(calls).size).toBe(calls.length);
      const expected = Array.from({ length: WORKERS * REMEMBERS }, (_, index) => `${SHELF}/${DAY}/${String(index + 1).padStart(3, "0")}`);
      expect(calls).toEqual(expected);
      const onShelf = await host.silo.memory.findMany({
        where: { callNumber: { startsWith: `${SHELF}/${DAY}/` } },
        select: { callNumber: true },
      });
      expect(onShelf.map((row) => row.callNumber).sort()).toEqual(expected);

      // Every update is its own version: none overwrote another.
      const updates = outcomes.filter((outcome) => outcome.op === "update");
      expect(updates.filter((outcome) => !outcome.ok)).toEqual([]);
      const versions = await host.silo.memoryVersion.count({ where: { memoryId: target.memory.id } });
      expect(versions).toBe(1 + WORKERS * UPDATES);

      // The shared memory is forgotten exactly once; each worker's own once.
      const forgets = outcomes.filter((outcome) => outcome.op === "forget");
      const sharedForgets = forgets.filter((outcome) => outcome.ref === shared.memory.call || outcome.message?.includes(shared.memory.call));
      expect(forgets.filter((outcome) => outcome.ok && outcome.ref === shared.memory.call)).toHaveLength(1);
      for (const outcome of sharedForgets.filter((entry) => !entry.ok)) expect(outcome.code).toBe("not_found");
      for (const call of own) {
        expect(forgets.filter((outcome) => outcome.ok && outcome.ref === call)).toHaveLength(1);
      }
      expect(forgets.filter((outcome) => !outcome.ok && outcome.code !== "not_found")).toEqual([]);
      for (const call of [shared.memory.call, ...own]) {
        expect(await host.silo.memory.findUnique({ where: { callNumber: call } })).toBeNull();
        expect(await host.silo.callNumberAlias.findUnique({ where: { oldCallNumber: call } })).not.toBeNull();
      }

      // Each proposal was confirmed exactly once and made exactly one memory.
      const decides = outcomes.filter((outcome) => outcome.op === "decide");
      for (const id of proposals) {
        const wins = decides.filter((outcome) => outcome.ok && outcome.ref?.startsWith(`${id} `));
        expect(wins, `proposal ${id}`).toHaveLength(1);
      }
      expect(decides.filter((outcome) => !outcome.ok && outcome.code !== "conflict")).toEqual([]);
      const garden = await host.silo.memory.count({ where: { title: { startsWith: "Garden plan" } } });
      expect(garden).toBe(PROPOSALS);
      expect(host.store.listProposals("pending")).toEqual([]);
      expect(host.store.listProposals("confirmed")).toHaveLength(PROPOSALS);

      // Every ended session is ready, with its pointer, and counted once.
      const ends = outcomes.filter((outcome) => outcome.op === "session-end");
      expect(ends.filter((outcome) => !outcome.ok)).toEqual([]);
      const ready = await coreTools.shared.readyForExtraction(host.ports);
      expect(new Set(ready).size).toBe(WORKERS * SESSION_ENDS);
      const pointers = await coreTools.shared.transcriptPointers(host.ports);
      expect(Object.keys(pointers).sort()).toEqual([...ready].sort());
      const counted = await coreTools.shared.readConsolidation(host.ports);
      expect(counted.sessionsSince).toBe(WORKERS * SESSION_ENDS);

      // Search is in step with the rows, and the audit log holds one line per call.
      expect(await storage.searchIntegrity(host.silo)).toEqual({ status: "ok" });
      const audit = host.store.listAudit(100_000);
      const byTool = (name: string) => audit.slice(0, audit.length - auditBefore).filter((row) => row.tool === name).length;
      expect(byTool("memory.remember")).toBe(WORKERS * REMEMBERS);
      expect(byTool("memory.update")).toBe(WORKERS * UPDATES);
      expect(byTool("memory.forget")).toBe(WORKERS * 2);
      expect(byTool("memory.decide")).toBe(WORKERS * PROPOSALS);
    } finally {
      await host.close();
    }
}
