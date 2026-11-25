import { afterEach, describe, expect, it } from "vitest";

import { estimateTokens } from "../../src/domain/recall/budget.js";
import type { CoreResult } from "../../src/tools/read/core.js";
import type { ExportResult } from "../../src/tools/read/export.js";
import type { TestHost } from "../test-host.js";
import { candidate, extractAndConfirm, file, gateHost, remember, turns } from "./harness.js";

/**
 * Gate: core is clean (guardrail 5). The core block never holds inferred or
 * external memories and never exceeds its token cap. A procedure is in it
 * whole or not at all.
 */

/** Twelve unrelated household facts, distinct enough to pass the duplicate guard. */
const NOTES = [
  "The blue folder on the third shelf of the study holds the boiler receipts.",
  "Spare light bulbs live in the drawer under the kitchen sink.",
  "The garden hose is coiled behind the shed next to the compost bin.",
  "Winter coats go in the hall cupboard from October until April.",
  "The car insurance renews every March with a paper letter.",
  "Recycling is collected on Tuesday mornings at the front gate.",
  "The wifi router sits on top of the bookcase in the living room.",
  "Picture hooks and nails are in a jar on the workbench.",
  "Batteries for the smoke alarm are kept in the top desk drawer.",
  "The window cleaner visits on the first Friday of each month.",
  "Extra blankets are folded in the chest at the foot of the bed.",
  "The bicycle pump hangs on a hook beside the back door.",
];

describe("core is clean", () => {
  let host: TestHost;

  afterEach(async () => {
    await host?.close();
  });

  const core = () => host.invoke<CoreResult>("memory.core", {});

  it("holds stated and confirmed memories, never inferred or external, whatever is pinned", async () => {
    host = await gateHost();
    const stated = await remember(host, { shelf: "LIF/HOM", body: "Prefers oat milk in coffee." });
    const confirmed = await extractAndConfirm(
      host,
      turns("Waters the plants every Sunday morning."),
      candidate({ title: "Plants", body: "Waters the plants every Sunday morning.", quote: "Waters the plants every Sunday morning." }),
    );
    const external = await extractAndConfirm(
      host,
      file("The office closes at six on Fridays."),
      candidate({ title: "Office", body: "The office closes at six on Fridays.", quote: "The office closes at six on Fridays." }),
    );
    const toBeInferred = await remember(host, { shelf: "LIF/HOM", body: "Likes the window seat on trains." });

    // inferred only exists by auto accept, which is off: it arrives by import here.
    const { snapshot } = await host.invoke<ExportResult>("memory.export", {});
    const file2 = JSON.parse(JSON.stringify(snapshot));
    for (const memory of file2.memories) if (memory.callNumber === toBeInferred.memory.call) memory.trust = "inferred";
    await host.invoke("memory.import", { snapshot: file2, mode: "merge", confirmedByUser: true });

    const calls = [stated.memory.call, confirmed.decided.committed!.call, external.decided.committed!.call, toBeInferred.memory.call];
    for (const call of calls) await host.invoke("memory.pin", { call, pinned: true });

    const block = await core();
    const included = block.included.map((item) => item.ref);
    expect(included).toEqual(expect.arrayContaining([stated.memory.call, confirmed.decided.committed!.call]));
    expect(included).not.toContain(external.decided.committed!.call);
    expect(included).not.toContain(toBeInferred.memory.call);
    expect(block.text).not.toContain("The office closes at six on Fridays.");
    expect(block.text).not.toContain("Likes the window seat on trains.");
    expect(block.excluded).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ref: external.decided.committed!.call, reason: "trust" }),
        expect.objectContaining({ ref: toBeInferred.memory.call, reason: "trust" }),
      ]),
    );
  });

  it.each([120, 200, 400, 800])("never exceeds a cap of %i tokens", async (cap) => {
    host = await gateHost({ config: { coreTokenCap: cap } });
    for (const body of NOTES) {
      const made = await remember(host, { shelf: "LIF/HOM", body });
      await host.invoke("memory.pin", { call: made.memory.call, pinned: true }).catch(() => undefined);
    }
    const block = await core();
    expect(block.tokens).toBeLessThanOrEqual(cap);
    expect(estimateTokens(block.text)).toBeLessThanOrEqual(cap);
    expect(block.cap).toBe(cap);
  });

  it("refuses a pin that would push the block past its cap, until something is unpinned", async () => {
    host = await gateHost({ config: { coreTokenCap: 120 } });
    const first = await remember(host, { shelf: "LIF/HOM", body: `${NOTES[0]} ${NOTES[1]} ${NOTES[2]} ${NOTES[3]}` });
    const second = await remember(host, { shelf: "LIF/HOM", body: `${NOTES[4]} ${NOTES[5]} ${NOTES[6]} ${NOTES[7]}` });
    await host.invoke("memory.pin", { call: first.memory.call, pinned: true });
    await expect(host.invoke("memory.pin", { call: second.memory.call, pinned: true })).rejects.toMatchObject({ code: "refused" });
    await host.invoke("memory.pin", { call: first.memory.call, pinned: false });
    await expect(host.invoke("memory.pin", { call: second.memory.call, pinned: true })).resolves.toMatchObject({ changed: true });
  });

  it("a procedure is in the block whole or not at all", async () => {
    host = await gateHost({ config: { coreTokenCap: 160 } });
    const rules = [
      {
        body: "Before any change to the build scripts, read the whole pipeline file and list every job it touches.",
        why: "A small change once broke the release job without anyone noticing.",
        howToApply: "Every edit under the scripts folder.",
      },
      {
        body: "Write database migrations so they can run twice without harm, and say how to roll each one back.",
        why: "A half applied migration took the staging silo down for an afternoon.",
        howToApply: "Every new file in the migrations folder.",
      },
      {
        body: "Keep pull requests under four hundred changed lines, splitting larger work into a stack.",
        why: "Reviews of huge diffs miss the bugs that matter.",
        howToApply: "Whenever a branch is opened for review.",
      },
      {
        body: "Name test files after the behaviour they pin down, never after the function they call.",
        why: "A rename should not hide which behaviour lost its test.",
        howToApply: "Every new test file.",
      },
    ];
    for (const rule of rules) {
      await host.invoke("memory.promote_procedure", { ...rule, shelf: "CRF/HOW", confirmedByUser: true });
    }
    const block = await core();
    expect(block.tokens).toBeLessThanOrEqual(160);
    let whole = 0;
    for (const rule of rules) {
      const parts = [rule.body, rule.why, rule.howToApply].map((part) => block.text.includes(part));
      expect(new Set(parts).size, rule.body).toBe(1);
      if (parts[0]) whole += 1;
    }
    expect(whole).toBeGreaterThan(0);
    expect(whole).toBeLessThan(rules.length);
    expect(block.dropped.filter((item) => item.slot === "procedures").length).toBe(rules.length - whole);
  });
});
