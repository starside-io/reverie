import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ExportResult } from "../../src/tools/read/export.js";
import { auditStrings, type TestHost } from "../test-host.js";
import { candidate, confirm, draft, gateHost, remember, SESSION_DATE, siloText, turns } from "./harness.js";

/**
 * Gate: secrets refused. Fixtures of keys, tokens, private keys and
 * passwords are rejected at every write: the direct door, update,
 * supersede, add_source, promote_procedure, propose_draft then decide,
 * import, and the session note. Merge writes no new text, so it has nothing
 * to scan; it is covered by the two memories it joins having passed.
 *
 * Every fixture is fake and built by string concatenation, so no file in
 * this repository holds a whole key for a scanner to find.
 */

const SECRETS: Record<string, string> = {
  "AWS access key id": "AKIA" + "Z3Q7RT2X9WLM4PBN",
  "GitHub token": "ghp" + "_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8",
  "Stripe secret key": "sk" + "_live_" + "4eC39HqLyjWDarjtT1zdp7dc",
  "private key block": "-----BEGIN " + "RSA PRIVATE KEY-----",
  password: "password" + ": " + "hunter2" + "Xq9",
};

const carrying = (secret: string) => `The router admin note says ${secret} for the garage.`;

describe("secrets refused at every write", () => {
  let host: TestHost;

  beforeEach(async () => {
    host = await gateHost();
  });
  afterEach(async () => {
    await host.close();
  });

  async function nothingLanded() {
    const text = await siloText(host);
    const logged = auditStrings(host).join("\n");
    for (const secret of Object.values(SECRETS)) {
      expect(text).not.toContain(secret);
      expect(logged).not.toContain(secret);
    }
  }

  const refused = { code: "refused", detail: { findings: expect.arrayContaining([expect.objectContaining({ check: "secret" })]) } };

  it.each(Object.entries(SECRETS))("the direct door refuses a %s in the body, the title and the quote", async (_label, secret) => {
    await expect(remember(host, { shelf: "LIF/HOM", body: carrying(secret) })).rejects.toMatchObject(refused);
    await expect(remember(host, { shelf: "LIF/HOM", title: `Router ${secret}`, body: "The router is in the garage." })).rejects.toMatchObject(refused);
    await expect(
      remember(host, { shelf: "LIF/HOM", body: "The router is in the garage.", said: carrying(secret) }),
    ).rejects.toMatchObject(refused);
    expect(await host.db.memory.count()).toBe(0);
    await nothingLanded();
  });

  it.each(Object.entries(SECRETS))("update, supersede and add_source refuse a %s", async (_label, secret) => {
    const kept = await remember(host, { shelf: "LIF/HOM", body: "The router is in the garage.", occurredOn: "2026-01-10" });
    await expect(host.invoke("memory.update", { call: kept.memory.call, body: carrying(secret) })).rejects.toMatchObject(refused);
    await expect(host.invoke("memory.supersede", { call: kept.memory.call, body: carrying(secret) })).rejects.toMatchObject(refused);
    await expect(
      host.invoke("memory.supersede", { call: kept.memory.call, body: "The router moved to the hall.", said: carrying(secret) }),
    ).rejects.toMatchObject(refused);
    await expect(host.invoke("memory.add_source", { call: kept.memory.call, quote: carrying(secret) })).rejects.toMatchObject(refused);
    expect(await host.db.memory.count()).toBe(1);
    expect(await host.db.memorySource.count()).toBe(1);
    await nothingLanded();
  });

  it.each(Object.entries(SECRETS))("promote_procedure refuses a %s in the rule or its quote", async (_label, secret) => {
    const base = { body: "Restart the router before a call.", why: "It drops video.", howToApply: "Before any call.", confirmedByUser: true };
    await expect(host.invoke("memory.promote_procedure", { ...base, body: `Log in with ${secret} then restart.` })).rejects.toMatchObject(refused);
    await expect(
      host.invoke("memory.promote_procedure", {
        ...base,
        sources: [{ source: { kind: "conversation", label: "session", trust: "stated" }, quote: carrying(secret) }],
      }),
    ).rejects.toMatchObject(refused);
    expect(await host.db.memory.count()).toBe(0);
    await nothingLanded();
  });

  it.each(Object.entries(SECRETS))("a draft carrying a %s is rejected at propose time and refused at decide time", async (_label, secret) => {
    const text = carrying(secret);
    const proposed = await draft(
      host,
      { job: "extract", material: turns(text), sessionDate: SESSION_DATE },
      { candidates: [candidate({ body: text, quote: text }), candidate({ body: "The router is in the garage.", quote: text })] },
    );
    expect(proposed.queued).toEqual([]);
    expect(proposed.rejected.map((entry) => entry.code)).toEqual(["discipline", "discipline"]);

    // Slipped into the queue by another door, decide still refuses it.
    const { id } = await host.ports.review.propose({
      tool: "memory.remember",
      payload: {
        kind: "fact",
        shelf: "LIF/HOM",
        body: "The router is in the garage.",
        draft: { job: "extract", source: { kind: "conversation", label: "session", trust: "stated" }, quote: text },
      },
    });
    await expect(confirm(host, id)).rejects.toMatchObject({ code: "refused", detail: { state: "pending", code: "refused" } });
    expect(await host.db.memory.count()).toBe(0);
  });

  it.each(Object.entries(SECRETS))("import refuses a file carrying a %s, and writes nothing", async (_label, secret) => {
    await remember(host, { shelf: "LIF/HOM", body: "The router is in the garage." });
    const { snapshot } = await host.invoke<ExportResult>("memory.export", {});
    for (const field of ["body", "title", "quote"] as const) {
      const file = JSON.parse(JSON.stringify(snapshot));
      if (field === "quote") file.memories[0].sources[0].quote = carrying(secret);
      else file.memories[0][field] = carrying(secret);
      for (const mode of ["merge", "replace"] as const) {
        await expect(
          host.invoke("memory.import", { snapshot: file, mode, dryRun: mode === "replace", confirmedByUser: true }),
          `${field} ${mode}`,
        ).rejects.toMatchObject({ code: "refused" });
      }
    }
    expect((await host.db.memory.findFirstOrThrow()).body).toBe("The router is in the garage.");
    await nothingLanded();
  });

  it.each(Object.entries(SECRETS))("the session note refuses a %s", async (_label, secret) => {
    await expect(host.invoke("memory.session_note", { body: carrying(secret) })).rejects.toMatchObject({ code: "refused" });
    await nothingLanded();
  });

  it("the refusal names what kind of secret, never the secret itself", async () => {
    const secret = SECRETS["GitHub token"] as string;
    const error = await remember(host, { shelf: "LIF/HOM", body: carrying(secret) }).catch((caught: unknown) => caught);
    expect(JSON.stringify({ message: (error as Error).message, detail: (error as { detail: unknown }).detail })).not.toContain(secret);
    expect(error).toMatchObject({ detail: { findings: expect.arrayContaining([expect.objectContaining({ label: "GitHub token" })]) } });
  });
});
