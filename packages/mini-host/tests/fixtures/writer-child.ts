import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";

import { tools as coreTools } from "@reverie/core";

import { startMiniHost } from "../../src/host.js";

/**
 * One writer in its own process, over the files REVERIE_DB_PATH and
 * REVERIE_HOST_DB_PATH name: what one more MCP server (one more Claude Code
 * session) looks like to the silo. It opens the files the way `reverie mcp`
 * does, says it is ready, waits for "go" on stdin so every writer starts at
 * once, runs the plan in REVERIE_TEST_PLAN through the registry, prints one
 * JSON line with every outcome, and exits.
 *
 * Every lane runs two calls at a time inside the process as well, because an
 * MCP client may send parallel tool calls to one server.
 */

interface Plan {
  worker: number;
  remember?: { count: number; shelf: string; occurredOn: string };
  update?: { call: string; count: number };
  forget?: { calls: string[] };
  decide?: { proposalIds: string[] };
  sessionEnds?: { ids: string[] };
}

interface Outcome {
  op: string;
  ok: boolean;
  /** The call number or id the op produced or acted on. */
  ref?: string;
  code?: string;
  message?: string;
}

const plan = JSON.parse(process.env["REVERIE_TEST_PLAN"] ?? "{}") as Plan;
const host = await startMiniHost();
const session = { id: `worker-${plan.worker}`, folder: null, gitRemote: null, agent: null };

async function attempt(op: string, run: () => Promise<string | undefined>): Promise<Outcome> {
  try {
    const ref = await run();
    return { op, ok: true, ...(ref ? { ref } : {}) };
  } catch (error) {
    const code = error instanceof coreTools.ToolError ? error.code : "failed";
    const message = error instanceof Error ? error.message : String(error);
    return { op, ok: false, code, message };
  }
}

/** Runs the jobs two at a time. */
async function lanes<T>(jobs: Array<() => Promise<T>>): Promise<T[]> {
  const out: T[] = new Array(jobs.length);
  let next = 0;
  const lane = async () => {
    while (next < jobs.length) {
      const index = next;
      next += 1;
      out[index] = await (jobs[index] as () => Promise<T>)();
    }
  };
  await Promise.all([lane(), lane()]);
  return out;
}

/** Words that share nothing from one body to the next, so the duplicate guard stays out of it. */
const words = () => Array.from({ length: 6 }, () => randomBytes(4).toString("hex")).join(" ");

async function runPlan(): Promise<Outcome[]> {
  const outcomes: Outcome[] = [];
  const invoke = (name: string, input: unknown) => host.api.invoke(name, input, { session });

  if (plan.remember) {
    const { count, shelf, occurredOn } = plan.remember;
    outcomes.push(
      ...(await lanes(
        Array.from({ length: count }, (_, index) => () =>
          attempt("remember", async () => {
            const result = (await invoke("memory.remember", {
              kind: "fact",
              shelf,
              occurredOn,
              body: `Jane Doe logged worker ${plan.worker} entry ${index}: ${words()}`,
            })) as { memory: { call: string } };
            return result.memory.call;
          }),
        ),
      )),
    );
  }

  if (plan.update) {
    const { call, count } = plan.update;
    outcomes.push(
      ...(await lanes(
        Array.from({ length: count }, (_, index) => () =>
          attempt("update", async () => {
            await invoke("memory.update", { call, body: `John Doe revised it, worker ${plan.worker} pass ${index}: ${words()}` });
            return call;
          }),
        ),
      )),
    );
  }

  if (plan.forget) {
    outcomes.push(
      ...(await lanes(
        plan.forget.calls.map((call) => () =>
          attempt("forget", async () => {
            await invoke("memory.forget", { call, confirmedByUser: true });
            return call;
          }),
        ),
      )),
    );
  }

  if (plan.decide) {
    outcomes.push(
      ...(await lanes(
        plan.decide.proposalIds.map((proposalId) => () =>
          attempt("decide", async () => {
            const result = (await invoke("memory.decide", { proposalId, decision: "confirm", confirmedByUser: true })) as {
              committed: { call: string } | null;
            };
            return `${proposalId} ${result.committed?.call ?? ""}`.trim();
          }),
        ),
      )),
    );
  }

  if (plan.sessionEnds) {
    outcomes.push(
      ...(await lanes(
        plan.sessionEnds.ids.map((id) => () =>
          attempt("session-end", async () => {
            const result = await host.publish("host.session.ended", {
              sessionId: id,
              transcriptPath: `/nowhere/reverie-test/${id}.jsonl`,
            });
            if (!result.handled) throw new Error(`not handled: ${result.reason}`);
            return id;
          }),
        ),
      )),
    );
  }

  return outcomes;
}

process.stdout.write(`${JSON.stringify({ ready: true, pid: process.pid })}\n`);
const input = createInterface({ input: process.stdin });
input.once("line", () => {
  void runPlan()
    .then(async (outcomes) => {
      await host.close();
      process.stdout.write(`${JSON.stringify({ worker: plan.worker, outcomes })}\n`, () => process.exit(0));
    })
    .catch(async (error: unknown) => {
      await host.close().catch(() => undefined);
      process.stdout.write(`${JSON.stringify({ worker: plan.worker, crashed: String(error) })}\n`, () => process.exit(1));
    });
});
