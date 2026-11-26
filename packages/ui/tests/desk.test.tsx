import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { FrontDesk } from "@/app/screens/desk";
import { SHELVES, entry, fakeHost } from "./fake-host";

describe("the front desk", () => {
  it("lists returns, occasions with no story, unresolved names, stale entries and conflicts", async () => {
    const host = fakeHost({
      "memory.shelves": () => SHELVES,
      "memory.browse": () => ({
        notice: "",
        order: "asc",
        items: [entry("DSK/RET/2026-11-20/001", "The bike lock code is in the blue notebook", { kind: "fact" })],
        nextCursor: null,
        anchor: null,
      }),
      "memory.review": () => ({
        state: "pending",
        proposals: [],
        groups: [],
        frontDesk: {
          occasionPending: [],
          occasionsWithNoStory: [
            { occasion: "module://people/event/e_9", title: "Lunch at Harbour Lane", occurredOn: "2026-12-02", people: [], loggedAt: "2026-12-02T12:00:00.000Z" },
          ],
          unresolvedNames: [{ name: "Sam Rivera", calls: ["LIF/GTH/2026-12-24/002"] }],
          notice: null,
        },
      }),
      "memory.stale": () => ({
        staleAfterDays: 180,
        cutoff: "2026-06-01T00:00:00.000Z",
        items: [{ ...entry("LIF/HOM/2026-01-05/001", "Prefers oat milk", { kind: "preference" }), daysSinceConfirmed: 300 }],
        total: 1,
      }),
      "memory.conflicts": () => ({
        pairs: [
          {
            linkId: "l-1",
            createdAt: "2026-12-01T00:00:00.000Z",
            from: { memoryId: "a", call: "LIF/HOM/2026-01-05/001", title: "Prefers oat milk", state: "active" },
            to: { memoryId: "b", call: "LIF/HOM/2026-11-02/001", title: "Prefers soy milk", state: "active" },
          },
        ],
        total: 1,
      }),
      "memory.shelve": () => ({ action: "move" }),
      "memory.touch": () => ({}),
    });
    render(<FrontDesk />);

    expect(await screen.findByText("The bike lock code is in the blue notebook")).toBeTruthy();
    expect(host.callsTo("memory.browse")[0]).toMatchObject({ shelf: "DSK/RET" });
    expect(await screen.findByText(/Lunch at Harbour Lane/)).toBeTruthy();
    expect(screen.getByText("Sam Rivera")).toBeTruthy();
    expect((await screen.findAllByText("Prefers oat milk")).length).toBeGreaterThan(0);
    expect(screen.getByText("Prefers soy milk")).toBeTruthy();

    // Returns is not offered as a place to shelve a return to.
    const select = screen.getByLabelText("Shelf for DSK/RET/2026-11-20/001") as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).not.toContain("DSK/RET");
    fireEvent.change(select, { target: { value: "LIF/TRV" } });
    fireEvent.click(within(select.closest("form") as HTMLElement).getByRole("button", { name: "Shelve" }));
    await waitFor(() =>
      expect(host.callsTo("memory.shelve")).toEqual([{ action: "move", call: "DSK/RET/2026-11-20/001", shelf: "LIF/TRV" }]),
    );

    fireEvent.click(screen.getByRole("button", { name: "Still true" }));
    await waitFor(() => expect(host.callsTo("memory.touch")).toEqual([{ call: "LIF/HOM/2026-01-05/001" }]));
  });
});
