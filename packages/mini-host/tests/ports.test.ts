import { describe, expect, it } from "vitest";

import type { ModelsPort } from "@reverie/core";

import { MEMORY_URI_PREFIX } from "../src/ports/index.js";
import { remember, throwawayHost } from "./harness.js";

/**
 * The ports, and the ones that carry a rule rather than a lookup: the
 * re-embed hook on the settings port, refs that answer only this module's
 * memories, a bus that records after the commit, and a privacy port that
 * stays the identity function. Lifted from Fellowship's ports.test.ts.
 */

/** A stand-in embedding model: a fixed small vector per text, and a record of what it was asked. */
function fakeModels(): ModelsPort & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    embed: async (texts) => {
      calls.push(texts);
      return texts.map((text) => [text.length % 7, 1, 0]);
    },
  };
}

describe("the settings port", () => {
  it("hands back the defaults until something is stored, with no embedding model", async () => {
    const host = await throwawayHost();
    try {
      const config = await host.ports.settings.get();
      expect(config.recall).toEqual({ floor: 0.35, maxItems: 8, tokenBudget: 1200 });
      expect(config.defaultShelf).toBe("DSK/RET");
      expect(config.embedding).toEqual({ model: null, dim: null });
      expect(config.incognito).toBe(false);
      expect(host.ports.models).toBeUndefined();
    } finally {
      await host.close();
    }
  });

  it("persists a change in host.db, not in the silo", async () => {
    const host = await throwawayHost();
    try {
      const before = await host.ports.settings.get();
      await host.ports.settings.set({ recall: { ...before.recall, floor: 0.5 } });
      const config = await host.ports.settings.get();
      expect(config.recall).toEqual({ floor: 0.5, maxItems: 8, tokenBudget: 1200 });
      expect(host.store.readSetting("module.config")).toMatchObject({ recall: { floor: 0.5 } });

      const siloTables = (
        await host.silo.$queryRawUnsafe<Array<{ name: string }>>(
          `SELECT "name" FROM sqlite_master WHERE "type" = 'table'`,
        )
      ).map((row) => row.name);
      expect(siloTables).not.toContain("setting");
    } finally {
      await host.close();
    }
  });

  it("refuses a value outside the declared range and keeps the old one", async () => {
    const host = await throwawayHost();
    try {
      await expect(host.ports.settings.set({ coreTokenCap: 5 })).rejects.toThrow();
      expect((await host.ports.settings.get()).coreTokenCap).toBe(800);
    } finally {
      await host.close();
    }
  });

  it("refuses an embedding model it has nothing to compute with, rather than store it as applied", async () => {
    const host = await throwawayHost();
    try {
      await expect(
        host.ports.settings.set({ embedding: { model: "nomic-embed-text", dim: null } }),
      ).rejects.toThrow(/cannot be applied/);
      expect((await host.ports.settings.get()).embedding.model).toBeNull();
    } finally {
      await host.close();
    }
  });

  it("re-embeds every memory before a model change counts as applied", async () => {
    const models = fakeModels();
    const host = await throwawayHost({ models });
    try {
      // No model configured yet, so writing computes nothing.
      await remember(host, { shelf: "LIF/HOM", body: "Prefers oat milk in coffee." });
      await remember(host, { shelf: "LIF/HOM", body: "The garden hose is coiled behind the shed." });
      expect(models.calls).toHaveLength(0);
      expect(await host.silo.embedding.count()).toBe(0);

      await host.ports.settings.set({ embedding: { model: "test-model", dim: 3 } });
      expect(models.calls.flat()).toHaveLength(2);
      const rows = await host.silo.embedding.findMany();
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.model === "test-model" && row.dim === 3)).toBe(true);

      // A second model replaces every vector of the first.
      await host.ports.settings.set({ embedding: { model: "test-model-2", dim: 3 } });
      const after = await host.silo.embedding.findMany();
      expect(after.map((row) => row.model)).toEqual(["test-model-2", "test-model-2"]);

      // And from here a write embeds at commit.
      await remember(host, { shelf: "LIF/HOM", body: "The bike pump lives in the hall cupboard." });
      expect(await host.silo.embedding.count()).toBe(3);
    } finally {
      await host.close();
    }
  });

  it("keeps settings values and project folders in host.db", async () => {
    const host = await throwawayHost();
    try {
      const values = host.ports.settings.values!;
      await values.set("core.ownerLine", "Jane Doe, who keeps bees in Elmwood.");
      expect(await values.get("core.ownerLine")).toBe("Jane Doe, who keeps bees in Elmwood.");
      expect(await values.get("never.set")).toBeUndefined();

      const paths = host.ports.settings.localPaths!;
      expect(await paths.add("nightstash", "/work/nightstash/")).toEqual({ added: true });
      // The same folder, written differently, is the same folder.
      expect(await paths.add("garden", "/work//nightstash")).toEqual({ added: false, heldBy: "nightstash" });
      expect(await paths.list("nightstash")).toEqual([{ project: "nightstash", path: "/work/nightstash" }]);
      expect(await paths.remove("/work/nightstash/")).toBe(true);
      expect(await paths.list()).toEqual([]);
    } finally {
      await host.close();
    }
  });
});

describe("the privacy port", () => {
  it("is the identity function, and says so rather than pretending", async () => {
    const host = await throwawayHost();
    try {
      const text = "Jane Doe said: see you at 8 in Elmwood.";
      expect(host.ports.privacy?.redact(text)).toBe(text);
    } finally {
      await host.close();
    }
  });
});

describe("the refs port", () => {
  it("answers its own memories by id, by call number and by an old call number", async () => {
    const host = await throwawayHost();
    try {
      const made = await remember(host, { shelf: "LIF/HOM", title: "Spare key", body: "The spare key hangs by the back door." });

      expect(await host.ports.refs.resolve(`${MEMORY_URI_PREFIX}${made.memory.id}`)).toMatchObject({
        status: "resolved",
        label: "Spare key",
        detail: { memoryId: made.memory.id, call: made.memory.call, state: "active" },
      });
      expect(await host.ports.refs.resolve(`${MEMORY_URI_PREFIX}${made.memory.call}`)).toMatchObject({
        status: "resolved",
        detail: { memoryId: made.memory.id },
      });

      const moved = (await host.api.invoke("memory.shelve", {
        action: "move",
        call: made.memory.call,
        shelf: "LIF/GTH",
      })) as { memory: { call: string } };
      expect(moved.memory.call).not.toBe(made.memory.call);
      expect(await host.ports.refs.resolve(`${MEMORY_URI_PREFIX}${made.memory.call}`)).toMatchObject({
        status: "resolved",
        detail: { call: moved.memory.call },
      });

      expect(await host.ports.refs.resolve(`${MEMORY_URI_PREFIX}nothing-here`)).toMatchObject({
        status: "unavailable",
      });
    } finally {
      await host.close();
    }
  });

  it("answers every people ref as unavailable, and anything else too", async () => {
    const host = await throwawayHost();
    try {
      for (const ref of [
        "module://people/person/p_sam",
        "module://people/event/e_8812",
        "module://calendar/event/1",
        "https://example.test/a",
      ]) {
        expect(await host.ports.refs.resolve(ref), ref).toMatchObject({ status: "unavailable", ref });
      }
    } finally {
      await host.close();
    }
  });
});

describe("the review and bus ports", () => {
  it("write to host.db, and the bus records and tells listeners after the fact", async () => {
    const host = await throwawayHost();
    const heard: string[] = [];
    host.emitter.on("*", (event: { name: string }) => heard.push(event.name));
    try {
      const made = await remember(host, { shelf: "LIF/HOM", body: "The bike pump lives in the hall cupboard." });

      const events = host.store.listEvents();
      expect(events.map((event) => event.name)).toEqual(["memory.memory.written"]);
      expect(events[0]!.payload).toMatchObject({ memoryId: made.memory.id });
      // Ids and call numbers, never memory text.
      expect(JSON.stringify(events)).not.toContain("bike pump");
      expect(heard).toEqual(["memory.memory.written"]);

      // A refused write emits nothing.
      await expect(
        host.api.invoke("memory.remember", { kind: "procedure", body: "Always write tests first." }),
      ).rejects.toThrow();
      expect(host.store.listEvents()).toHaveLength(1);

      const { id } = await host.ports.review.propose({
        tool: "memory.remember",
        memoryId: null,
        payload: {},
        summary: "A fact",
      });
      expect(host.store.listProposals("pending")[0]!.id).toBe(id);
      expect(await host.ports.review.get(id)).toMatchObject({ id, state: "pending", memoryId: null });
      expect(await host.ports.review.decide(id, "discarded")).toBe(true);
      expect(await host.ports.review.decide(id, "confirmed")).toBe(false);
    } finally {
      await host.close();
    }
  });

  it("delivers a listened event in this process, and records it in the feed", async () => {
    const host = await throwawayHost();
    try {
      const result = await host.publish("host.session.ended", { sessionId: "session-jane-1" });
      expect(result).toMatchObject({
        event: "host.session.ended",
        handled: true,
        detail: { sessionId: "session-jane-1", readyForExtraction: true, counted: true, sessionsSince: 1 },
      });
      expect(host.store.readValue("sessions.readyForExtraction")).toEqual(["session-jane-1"]);
      expect(host.store.listEvents()[0]).toMatchObject({ name: "host.session.ended" });

      // Delivered twice, counted once.
      expect(await host.publish("host.session.ended", { sessionId: "session-jane-1" })).toMatchObject({
        detail: { counted: false },
      });

      // A people event with nobody to match finds nothing and writes nothing.
      expect(
        await host.publish("people.person.created", { personId: "p_sam", name: "Sam Rivera" }),
      ).toMatchObject({ handled: true, detail: { matches: [] } });
    } finally {
      await host.close();
    }
  });
});
