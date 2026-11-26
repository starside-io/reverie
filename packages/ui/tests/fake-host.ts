import { vi } from "vitest";

/**
 * A faked host for component tests: fetch is stubbed, and each tool answers
 * from a handler. Every call is recorded, so a test can say exactly which
 * tool a screen called and with what. Nothing here reaches a real host or a
 * database. Every name is invented.
 */

export type Handler = (input: Record<string, unknown>) => unknown;

export class ToolRefusal {
  constructor(
    readonly code: string,
    readonly message: string,
    readonly detail?: unknown,
  ) {}
}

export interface FakeHost {
  calls: Array<{ tool: string; input: Record<string, unknown> }>;
  decisions: Array<{ id: string; decision: string }>;
  callsTo(tool: string): Array<Record<string, unknown>>;
}

export function fakeHost(
  handlers: Record<string, Handler>,
  options: { decide?: (id: string, decision: string) => { status: number; body: unknown } } = {},
): FakeHost {
  const host: FakeHost = {
    calls: [],
    decisions: [],
    callsTo: (tool) => host.calls.filter((call) => call.tool === tool).map((call) => call.input),
  };

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const decision = /^\/host\/review\/([^/]+)\/(confirm|reject)$/.exec(url);
      if (decision) {
        const id = decodeURIComponent(decision[1] as string);
        host.decisions.push({ id, decision: decision[2] as string });
        const answer = options.decide?.(id, decision[2] as string) ?? {
          status: 200,
          body: { ok: true, state: decision[2] === "confirm" ? "confirmed" : "discarded", committed: null },
        };
        return json(answer.body, answer.status);
      }
      if (url !== "/rpc") return json({ error: `No fake for ${url}` }, 404);

      const body = JSON.parse(String(init?.body ?? "{}")) as { tool: string; input?: Record<string, unknown> };
      const input = body.input ?? {};
      host.calls.push({ tool: body.tool, input });
      const handler = handlers[body.tool];
      if (!handler) {
        return json({ ok: false, tool: body.tool, error: { code: "unknown_tool", message: `No fake for ${body.tool}` } }, 404);
      }
      try {
        const result = await handler(input);
        if (result instanceof ToolRefusal) {
          return json({ ok: false, tool: body.tool, error: { code: result.code, message: result.message, detail: result.detail } }, 409);
        }
        return json({ ok: true, tool: body.tool, result });
      } catch (error) {
        return json({ ok: false, tool: body.tool, error: { code: "failed", message: String(error) } }, 500);
      }
    }),
  );
  return host;
}

/* --------------------------------------------------------------- data */

export const SHELVES = {
  sections: [
    {
      code: "LIF",
      name: "Life",
      order: 1,
      count: 2,
      total: 2,
      shelves: [
        { code: "GTH", path: "LIF/GTH", name: "Gatherings", description: "Parties, dinners and visits.", order: 0, count: 2, total: 2 },
        { code: "TRV", path: "LIF/TRV", name: "Travel", description: "Trips.", order: 1, count: 0, total: 0 },
      ],
    },
    {
      code: "DSK",
      name: "Front desk",
      order: 4,
      count: 1,
      total: 1,
      shelves: [
        { code: "RET", path: "DSK/RET", name: "Returns", description: "Waiting for a shelf.", order: 0, count: 1, total: 1 },
      ],
    },
  ],
};

export function entry(call: string, title: string, extra: Record<string, unknown> = {}) {
  const [section, shelf, day] = call.split("/");
  return {
    id: `id-${call}`,
    call,
    shelf: `${section}/${shelf}`,
    occurredOn: day,
    kind: "episode",
    state: "active",
    trust: "stated",
    scope: "global",
    scopeRef: null,
    title,
    excerpt: `${title}.`,
    tags: [],
    pinned: false,
    lastConfirmedAt: "2026-12-27T10:00:00.000Z",
    ...extra,
  };
}

export const CHRISTMAS = "LIF/GTH/2026-12-24/001";

export function memoryView(call = CHRISTMAS, extra: Record<string, unknown> = {}) {
  const [section, shelf, day] = call.split("/");
  return {
    id: "m-1",
    call,
    shelf: `${section}/${shelf}`,
    occurredOn: day,
    seq: 1,
    kind: "episode",
    scope: "global",
    scopeRef: null,
    title: "Hosted Christmas at the Elmwood cottage",
    body: "Hosted Christmas for Jane Doe and John Doe at the Elmwood cottage. The oven died, so we ordered pizza.",
    why: null,
    howToApply: null,
    importance: 3,
    trust: "stated",
    state: "active",
    validFrom: "2026-12-24T00:00:00.000Z",
    validTo: null,
    supersededBy: null,
    pinned: false,
    lastConfirmedAt: "2026-12-27T10:00:00.000Z",
    createdAt: "2026-12-27T10:00:00.000Z",
    tags: ["christmas", "hosting"],
    attendees: [
      { role: "attendee", uri: null, label: "Jane Doe", status: "unresolved" },
      { role: "attendee", uri: "module://people/person/p_john", label: "John Doe", status: "resolved" },
    ],
    occasion: { role: "occasion", uri: "module://people/event/e_1", label: "Christmas at Elmwood", status: "resolved" },
    mentions: [],
    sources: [],
    aliases: [],
    ...extra,
  };
}
