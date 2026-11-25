import { DatabaseSync } from "node:sqlite";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";

import { PACKAGE_ROOT } from "./fixtures/children.js";
import { envFor, filesIn, throwawayDir } from "./harness.js";

/**
 * The milestone's own test (docs/SPEC.md section 23, M3): an assistant can
 * remember, browse, recall and forget with no UI. The real server runs in
 * its own process, spoken to over its stdin and stdout by the SDK's client,
 * exactly as an MCP client starts it. Any line on stdout that is not
 * protocol breaks the client, so a clean run also proves stdout carries
 * nothing else.
 */

type Content = { content?: Array<{ type: string; text?: string }>; isError?: boolean };

function textOf(result: unknown): string {
  return ((result as Content).content ?? []).find((entry) => entry.type === "text")?.text ?? "";
}

function payloadOf<T>(result: unknown): T {
  return JSON.parse(textOf(result)) as T;
}

const BODY = "Hosted Christmas for Jane Doe and John Doe. The oven died, so we ordered pizza.";
const TITLE = "Christmas at the cottage";
const QUERY = "christmas oven pizza";
const OTHER_QUERY = "submarine telescope";

describe("an assistant over stdio, with no UI", () => {
  it("remembers, browses, recalls, abstains and forgets, and the audit holds no memory text", async () => {
    const dir = throwawayDir();
    const files = filesIn(dir);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "src/mcp.ts"],
      cwd: PACKAGE_ROOT,
      env: { ...(envFor(dir) as Record<string, string>), REVERIE_SESSION_ID: "session-e2e-1" },
      stderr: "pipe",
    });
    const client = new Client({ name: "test-assistant", version: "0.0.1" });
    const errors: Error[] = [];
    client.onerror = (error) => errors.push(error);

    await client.connect(transport);
    try {
      expect(client.getServerVersion()).toMatchObject({ name: "reverie" });
      expect(client.getInstructions()).toContain("memory_recall");

      const listed = await client.listTools();
      expect(listed.tools).toHaveLength(41);

      // Remember: what the owner states goes straight in.
      const made = payloadOf<{ memory: { id: string; call: string } }>(
        await client.callTool({
          name: "memory_remember",
          arguments: {
            kind: "episode",
            shelf: "LIF/GTH",
            occurredOn: "2026-12-24",
            title: TITLE,
            body: BODY,
            tags: ["christmas"],
            attendees: ["Jane Doe", "module://people/person/p_john"],
          },
        }),
      );
      expect(made.memory.call).toBe("LIF/GTH/2026-12-24/001");

      // Browse: the shelf, in order.
      const browsed = payloadOf<{ items: Array<{ call: string; title: string }> }>(
        await client.callTool({ name: "memory_browse", arguments: { shelf: "LIF/GTH" } }),
      );
      expect(browsed.items.map((item) => item.call)).toEqual([made.memory.call]);
      expect(browsed.items[0]!.title).toBe(TITLE);

      // Recall: a hit, framed as data.
      const hit = payloadOf<{ sufficient: boolean; notice: string; items: Array<{ call: string }> }>(
        await client.callTool({ name: "memory_recall", arguments: { query: QUERY } }),
      );
      expect(hit.sufficient).toBe(true);
      expect(hit.items.map((item) => item.call)).toEqual([made.memory.call]);
      expect(hit.notice.length).toBeGreaterThan(0);

      // Recall: abstention, when nothing clears the floor.
      const miss = payloadOf<unknown>(await client.callTool({ name: "memory_recall", arguments: { query: OTHER_QUERY } }));
      expect(miss).toEqual({ items: [], sufficient: false });

      // Forget, without the owner's yes: refused, and the memory stays.
      const refused = await client.callTool({ name: "memory_forget", arguments: { call: made.memory.call } });
      expect(refused.isError).toBe(true);
      expect(textOf(refused)).toContain("invalid_input");
      const stillThere = await client.callTool({ name: "memory_get", arguments: { call: made.memory.call } });
      expect(stillThere.isError).toBeFalsy();

      // The owner was shown the memory and said yes.
      const forgotten = payloadOf<{ forgotten: { call: string; retiredNumbers: string[] } }>(
        await client.callTool({
          name: "memory_forget",
          arguments: { call: made.memory.call, confirmedByUser: true },
        }),
      );
      expect(forgotten.forgotten.call).toBe(made.memory.call);
      expect(forgotten.forgotten.retiredNumbers).toContain(made.memory.call);

      // Gone from every way back in.
      expect(payloadOf<unknown>(await client.callTool({ name: "memory_recall", arguments: { query: QUERY } }))).toEqual({
        items: [],
        sufficient: false,
      });
      expect(
        payloadOf<{ items: unknown[] }>(await client.callTool({ name: "memory_browse", arguments: { shelf: "LIF/GTH" } }))
          .items,
      ).toEqual([]);
      const lookup = await client.callTool({ name: "memory_get", arguments: { call: made.memory.call } });
      expect(lookup.isError).toBe(true);
      expect(textOf(lookup)).toMatch(/^not_found/);
    } finally {
      await client.close();
    }

    expect(errors).toEqual([]);

    // The audit log, read straight from host.db: ids, counts and refusal codes.
    const hostDb = new DatabaseSync(files.hostDbPath, { readOnly: true });
    try {
      const rows = hostDb.prepare(`SELECT * FROM "audit" ORDER BY "id"`).all() as Array<Record<string, unknown>>;
      expect(rows.map((row) => row["tool"])).toEqual([
        "memory.remember",
        "memory.browse",
        "memory.recall",
        "memory.recall",
        "memory.forget",
        "memory.get",
        "memory.forget",
        "memory.recall",
        "memory.browse",
        "memory.get",
      ]);
      const text = JSON.stringify(rows);
      for (const needle of [BODY, TITLE, QUERY, OTHER_QUERY, "Christmas", "christmas", "oven", "pizza", "Jane Doe", "submarine"]) {
        expect(text, needle).not.toContain(needle);
      }
      // A refusal is the half worth reading back.
      expect(JSON.parse(String(rows[4]!["detail"]))).toEqual({ refused: "invalid_input" });
    } finally {
      hostDb.close();
    }
  });
});
