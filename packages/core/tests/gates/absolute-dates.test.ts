import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DraftContextResult } from "../../src/tools/drafting/draft-context.js";
import type { ExportResult } from "../../src/tools/read/export.js";
import type { TestHost } from "../test-host.js";
import { candidate, confirm, draft, extractAndConfirm, gateHost, remember, SESSION_DATE, turns } from "./harness.js";

/**
 * Gate: absolute dates. "Yesterday" and "next week" in a body are refused at
 * every write. The drafter is told the session date and must resolve them.
 * The owner's own words, kept as the quote, may say "yesterday": the quote
 * is what was said, the body is what is kept.
 */

const RELATIVE = ["We fixed the gate yesterday.", "The plumber comes next week.", "Sam Rivera visited three days ago."];

const relative = { code: "refused", detail: { findings: expect.arrayContaining([expect.objectContaining({ check: "relativeDate" })]) } };

describe("absolute dates", () => {
  let host: TestHost;

  beforeEach(async () => {
    host = await gateHost();
  });
  afterEach(async () => {
    await host.close();
  });

  it.each(RELATIVE)("the direct door, update, supersede and promote_procedure refuse %j", async (body) => {
    await expect(remember(host, { shelf: "LIF/HOM", body })).rejects.toMatchObject(relative);
    const kept = await remember(host, { shelf: "LIF/HOM", body: "The gate hinge was fixed on 2026-12-26.", occurredOn: "2026-12-26" });
    await expect(host.invoke("memory.update", { call: kept.memory.call, body })).rejects.toMatchObject(relative);
    await expect(host.invoke("memory.supersede", { call: kept.memory.call, body })).rejects.toMatchObject(relative);
    await expect(
      host.invoke("memory.promote_procedure", { body, why: "Because.", howToApply: "Always.", confirmedByUser: true }),
    ).rejects.toMatchObject(relative);
    expect(await host.db.memory.count()).toBe(1);
  });

  it.each(RELATIVE)("a draft whose body says %j is rejected, and refused at decide when slipped into the queue", async (body) => {
    const proposed = await draft(
      host,
      { job: "extract", material: turns(body), sessionDate: SESSION_DATE },
      { candidates: [candidate({ body, quote: body })] },
    );
    expect(proposed.queued).toEqual([]);
    expect(proposed.rejected[0]).toMatchObject({ code: "discipline", detail: { findings: [expect.objectContaining({ check: "relativeDate" })] } });

    const { id } = await host.ports.review.propose({
      tool: "memory.remember",
      payload: {
        kind: "fact",
        shelf: "LIF/HOM",
        body,
        draft: { job: "extract", source: { kind: "conversation", label: "session", trust: "stated" }, quote: body },
      },
    });
    await expect(confirm(host, id)).rejects.toMatchObject({ code: "refused", detail: { state: "pending" } });
  });

  it("import refuses a body with a relative date", async () => {
    await remember(host, { shelf: "LIF/HOM", body: "The gate hinge was fixed on 2026-12-26." });
    const { snapshot } = await host.invoke<ExportResult>("memory.export", {});
    const file = JSON.parse(JSON.stringify(snapshot));
    file.memories[0].body = "We fixed the gate yesterday.";
    await expect(host.invoke("memory.import", { snapshot: file, mode: "merge", confirmedByUser: true })).rejects.toMatchObject({ code: "refused" });
  });

  it("the drafter is told the session date, and a resolved body lands with the owner's words as its quote", async () => {
    const context = await host.invoke<DraftContextResult>("memory.draft_context", {
      job: "extract",
      material: turns("We fixed the gate yesterday."),
      sessionDate: SESSION_DATE,
    });
    expect(`${context.system}\n${context.prompt}`).toContain(SESSION_DATE);
    expect(context.rules.join(" ")).toMatch(/relative|yesterday/i);

    const { decided } = await extractAndConfirm(
      host,
      turns("We fixed the gate yesterday."),
      candidate({ body: "Fixed the garden gate on 2026-12-26.", occurredOn: "2026-12-26", quote: "We fixed the gate yesterday." }),
    );
    const row = await host.db.memory.findUniqueOrThrow({ where: { callNumber: decided.committed!.call }, include: { sources: true } });
    expect(row.callNumber).toMatch(/\/2026-12-26\//);
    expect(row.sources[0]?.quote).toBe("We fixed the gate yesterday.");

    const direct = await remember(host, { shelf: "LIF/HOM", body: "Paid the plumber on 2026-12-26.", said: "I paid the plumber yesterday." });
    expect(direct.memory.sources[0]?.quote).toBe("I paid the plumber yesterday.");
  });
});
