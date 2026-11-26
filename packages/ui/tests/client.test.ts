import { afterEach, describe, expect, it, vi } from "vitest";

import { RpcError, host, rpc } from "@/client";

/**
 * The one way in. Everything the UI knows about the host is here, so the
 * shapes it promises the screens are pinned down.
 */

function answerWith(body: unknown, status = 200) {
  return vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("rpc", () => {
  it("posts the tool and its input as JSON to /rpc, and unwraps the result", async () => {
    const fetchMock = answerWith({ ok: true, tool: "memory.tags", result: { tags: [] } });
    vi.stubGlobal("fetch", fetchMock);

    expect(await rpc("memory.tags", {})).toEqual({ tags: [] });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/rpc");
    expect(init.method).toBe("POST");
    // application/json, so a browser never sends it as a simple request.
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(String(init.body))).toEqual({ tool: "memory.tags", input: {} });
  });

  it("turns a refusal into an RpcError with the code, message and field issues", async () => {
    vi.stubGlobal(
      "fetch",
      answerWith(
        {
          ok: false,
          tool: "memory.remember",
          error: { code: "invalid_input", message: "Bad input", detail: { issues: [{ path: ["body"], message: "A body is required" }] } },
        },
        400,
      ),
    );
    const error = (await rpc("memory.remember", {}).catch((caught: unknown) => caught)) as RpcError;
    expect(error).toBeInstanceOf(RpcError);
    expect(error.code).toBe("invalid_input");
    expect(error.issues).toEqual([{ path: "body", message: "A body is required" }]);
  });

  it("says the host is unreachable when nothing answers", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("fetch failed"))));
    const error = (await rpc("memory.tags").catch((caught: unknown) => caught)) as RpcError;
    expect(error.code).toBe("unreachable");
  });
});

describe("host.decide", () => {
  it("posts the owner's decision to the mini-host's review route", async () => {
    const fetchMock = answerWith({ ok: true, state: "confirmed", committed: { call: "LIF/GTH/2026-12-27/001" } });
    vi.stubGlobal("fetch", fetchMock);

    expect(await host.decide("p 1", "confirm")).toEqual({ ok: true, committed: "LIF/GTH/2026-12-27/001" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/host/review/p%201/confirm");
    expect(init.method).toBe("POST");
  });

  it("hands back the refusal when the write the proposal names did not happen", async () => {
    vi.stubGlobal(
      "fetch",
      answerWith({ ok: false, error: { code: "refused", message: "The proposed memory.remember was refused" } }, 409),
    );
    expect(await host.decide("p1", "confirm")).toEqual({ ok: false, message: "The proposed memory.remember was refused" });
  });
});
