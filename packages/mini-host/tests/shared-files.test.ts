import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { tools as coreTools } from "@reverie/core";

import { openHostDb } from "../src/host-db.js";
import { CLAIM_LAPSE_MS, HostStore } from "../src/ports/index.js";
import { filesIn, throwawayDir, throwawayHost } from "./harness.js";

/**
 * The host side of several processes sharing host.db, and of the transcripts
 * connector: a proposal claimed by one decider at a time, values updated
 * under one write lock, and a transcript read only through the pointer kept
 * for a session still waiting. Every name is invented.
 */

describe("a proposal claim", () => {
  it("lets one holder decide at a time, lapses when its holder died, and goes with the decision", () => {
    const dir = throwawayDir();
    const path = filesIn(dir).hostDbPath;
    const one = openHostDb(path);
    const two = openHostDb(path);
    try {
      const a = new HostStore(one);
      const b = new HostStore(two);
      const { id } = a.propose({ tool: "memory.retire", payload: { call: "LIF/HOM/2026-11-20/001" } });

      expect(a.claimProposal(id, "holder-a")).toBe(true);
      expect(b.claimProposal(id, "holder-b")).toBe(false);
      expect(a.claimProposal(id, "holder-a")).toBe(false);

      // Someone else's claim is not released by another holder.
      b.releaseProposal(id, "holder-b");
      expect(b.claimProposal(id, "holder-b")).toBe(false);

      a.releaseProposal(id, "holder-a");
      expect(b.claimProposal(id, "holder-b")).toBe(true);

      // A claim older than the lapse is taken over.
      const later = new Date(Date.now() + CLAIM_LAPSE_MS + 1000);
      expect(a.claimProposal(id, "holder-a", later)).toBe(true);

      expect(a.decideProposal(id, "discarded")).toBe(true);
      expect(b.claimProposal(id, "holder-b")).toBe(false);
      expect(one.db.prepare(`SELECT COUNT(*) AS n FROM "proposal_claim"`).get()).toEqual({ n: 0 });
    } finally {
      one.close();
      two.close();
    }
  });
});

describe("values updated under one write lock", () => {
  it("reads and writes several keys as one step", () => {
    const dir = throwawayDir();
    const host = openHostDb(filesIn(dir).hostDbPath);
    try {
      const store = new HostStore(host);
      store.writeValue("list", ["a"]);
      const after = store.updateValues(["list", "count"], (current) => ({
        list: [...(current["list"] as string[]), "b"],
        count: 1,
      }));
      expect(after).toEqual({ list: ["a", "b"], count: 1 });
      expect(store.readValue("list")).toEqual(["a", "b"]);
      expect(() =>
        store.updateValues(["list"], () => {
          throw new Error("changed its mind");
        }),
      ).toThrow("changed its mind");
      expect(store.readValue("list")).toEqual(["a", "b"]);
      expect(host.db.isTransaction).toBe(false);
    } finally {
      host.close();
    }
  });
});

describe("the transcripts connector on the mini-host", () => {
  it("reads the pointer of a session still waiting, and nothing once it stops waiting", async () => {
    const dir = throwawayDir();
    const transcript = join(dir, "projects", "session-jane.jsonl");
    mkdirSync(join(dir, "projects"), { recursive: true });
    writeFileSync(
      transcript,
      `${JSON.stringify({ type: "user", message: { role: "user", content: "Jane Doe planted the garlic." } })}\n`,
    );
    const host = await throwawayHost({ dir });
    try {
      const connectors = host.ports.connectors;
      expect(connectors).toBeDefined();
      const pull = (session: string) => connectors!.pull("transcripts", JSON.stringify({ session }));
      const code = (session: string) => pull(session).then(() => "read", (error: { code?: string }) => error.code);

      expect(await code("session-jane")).toBe("no_pointer");
      await host.publish("host.session.ended", { sessionId: "session-jane", transcriptPath: transcript });
      const read = await pull("session-jane");
      expect(read.items.map((item) => (item.payload as { text: string }).text)).toEqual(["Jane Doe planted the garlic."]);

      await coreTools.shared.clearReadyForExtraction(host.ports, "session-jane");
      expect(await code("session-jane")).toBe("no_pointer");
      await expect(connectors!.pull("calendar", null)).rejects.toMatchObject({ code: "unknown_connector" });
      await expect(connectors!.push!("calendar", {})).rejects.toMatchObject({ code: "unknown_connector" });
      await expect(connectors!.pull("markdown", null)).rejects.toMatchObject({ code: "bad_cursor" });
    } finally {
      await host.close();
    }
  });

  it("is left out when the host is started without it", async () => {
    const dir = throwawayDir();
    const { startMiniHost } = await import("../src/host.js");
    const host = await startMiniHost({ ...filesIn(dir), transcripts: false });
    try {
      expect(host.ports.connectors).toBeUndefined();
    } finally {
      await host.close();
    }
  });
});
