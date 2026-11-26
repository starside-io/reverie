import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Library } from "@/app/screens/library";
import { SHELVES, entry, fakeHost } from "./fake-host";

describe("the library screen", () => {
  it("puts sections down the side, the section's shelves across, and opens a shelf as a dated list", async () => {
    const host = fakeHost({
      "memory.shelves": () => SHELVES,
      "memory.browse": () => ({
        notice: "",
        order: "asc",
        items: [
          entry("LIF/GTH/2026-12-24/001", "Hosted Christmas at the Elmwood cottage", { tags: ["christmas"] }),
          entry("LIF/GTH/2026-12-24/002", "Sam Rivera brought a board game"),
          entry("LIF/GTH/2026-12-31/001", "New Year at Port Calder"),
        ],
        nextCursor: null,
        anchor: null,
      }),
    });

    render(<Library section={null} shelf="LIF/GTH" />);

    const sections = await screen.findByRole("complementary", { name: "Sections" });
    expect(within(sections).getByText("Life")).toBeTruthy();
    expect(within(sections).getByText("Front desk")).toBeTruthy();

    const across = screen.getByRole("navigation", { name: "Shelves in Life" });
    expect(within(across).getByText("Gatherings")).toBeTruthy();
    expect(within(across).getByText("Travel")).toBeTruthy();

    const shelf = await screen.findByRole("region", { name: "Shelf LIF/GTH" });
    const days = within(shelf).getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent);
    expect(days).toEqual(["24 December 2026", "31 December 2026"]);
    const links = within(shelf)
      .getAllByRole("link")
      .map((link) => link.getAttribute("href"));
    // Call number order, which is time order on one shelf.
    expect(links).toEqual([
      "/memory/LIF/GTH/2026-12-24/001",
      "/memory/LIF/GTH/2026-12-24/002",
      "/memory/LIF/GTH/2026-12-31/001",
    ]);
    expect(host.callsTo("memory.browse")[0]).toMatchObject({ shelf: "LIF/GTH", order: "asc", includeRetired: false });
  });

  it("says an empty shelf is an empty page rather than an error", async () => {
    fakeHost({
      "memory.shelves": () => SHELVES,
      "memory.browse": () => ({ notice: "", order: "asc", items: [], nextCursor: null, anchor: null }),
    });
    render(<Library section="LIF" shelf="LIF/TRV" />);
    expect(await screen.findByText("Nothing on this shelf yet")).toBeTruthy();
  });
});
