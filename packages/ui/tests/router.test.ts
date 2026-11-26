import { describe, expect, it } from "vitest";

import { hrefOf, parseRoute } from "@/lib/router";

describe("the router", () => {
  it("reads every screen from its path", () => {
    expect(parseRoute("/")).toEqual({ name: "library", section: null, shelf: null });
    expect(parseRoute("/library/LIF")).toEqual({ name: "library", section: "LIF", shelf: null });
    expect(parseRoute("/library/LIF/GTH")).toEqual({ name: "library", section: "LIF", shelf: "LIF/GTH" });
    expect(parseRoute("/timeline")).toEqual({ name: "timeline" });
    expect(parseRoute("/tags")).toEqual({ name: "tags" });
    expect(parseRoute("/review/")).toEqual({ name: "review" });
    expect(parseRoute("/recall")).toEqual({ name: "recall" });
    expect(parseRoute("/desk")).toEqual({ name: "desk" });
  });

  it("takes a call number in the path as it is written, for a deep link", () => {
    expect(parseRoute("/memory/LIF/GTH/2026-12-24/001")).toEqual({ name: "memory", call: "LIF/GTH/2026-12-24/001" });
    expect(hrefOf({ name: "memory", call: "LIF/GTH/2026-12-24/001" })).toBe("/memory/LIF/GTH/2026-12-24/001");
    expect(parseRoute("/memory/LIF/GTH/2026-12-24")).toEqual({ name: "unknown", path: "/memory/LIF/GTH/2026-12-24" });
  });

  it("round trips every route it can name", () => {
    for (const path of ["/", "/library/WRK", "/library/WRK/NST", "/timeline", "/tags", "/review", "/recall", "/desk"]) {
      expect(hrefOf(parseRoute(path))).toBe(path);
    }
  });
});
