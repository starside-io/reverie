import { render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Timeline, onOneAxis, shiftMonth } from "@/app/screens/timeline";
import { entry, fakeHost } from "./fake-host";

describe("the timeline", () => {
  it("moves a month at a time across a year end", () => {
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2027-01", -1)).toBe("2026-12");
  });

  it("puts every shelf on one axis, by the day things happened", async () => {
    // browse walks by call number, so WRK sorts after LIF whatever the day.
    const pages = [
      {
        items: [entry("LIF/GTH/2026-12-24/001", "Christmas"), entry("LIF/TRV/2026-12-02/001", "Train to Port Calder")],
        nextCursor: "LIF/TRV/2026-12-02/001",
      },
      { items: [entry("WRK/NST/2026-12-10/001", "Pricing call")], nextCursor: null },
    ];
    const host = fakeHost({
      "memory.tags": () => ({ tags: [] }),
      "memory.browse": () => ({ notice: "", order: "asc", anchor: null, ...pages.shift() }),
    });
    window.history.replaceState({}, "", "/timeline");
    render(<Timeline />);

    await waitFor(() => expect(screen.getAllByRole("link").length).toBe(3));
    const order = screen.getAllByRole("link").map((link) => link.getAttribute("href"));
    expect(order).toEqual([
      "/memory/LIF/TRV/2026-12-02/001",
      "/memory/WRK/NST/2026-12-10/001",
      "/memory/LIF/GTH/2026-12-24/001",
    ]);
    expect(host.callsTo("memory.browse")[1]).toMatchObject({ cursor: "LIF/TRV/2026-12-02/001" });
    expect(within(screen.getByRole("region", { name: "2 December 2026" })).getByText("Train to Port Calder")).toBeTruthy();
  });

  it("sorts by day, then by call number within a day", () => {
    const sorted = onOneAxis([
      { occurredOn: "2026-12-24", call: "LIF/HOM/2026-12-24/001" },
      { occurredOn: "2026-12-24", call: "LIF/GTH/2026-12-24/002" },
      { occurredOn: "2026-12-01", call: "WRK/NST/2026-12-01/001" },
    ]);
    expect(sorted.map((item) => item.call)).toEqual([
      "WRK/NST/2026-12-01/001",
      "LIF/GTH/2026-12-24/002",
      "LIF/HOM/2026-12-24/001",
    ]);
  });
});
