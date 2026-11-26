import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Memory } from "@/app/screens/memory";
import { CHRISTMAS, SHELVES, ToolRefusal, fakeHost, memoryView } from "./fake-host";

function memoryHost(extra: Record<string, (input: Record<string, unknown>) => unknown> = {}) {
  return fakeHost({
    "memory.get": () => ({ notice: "", moved: false, memory: memoryView() }),
    "memory.shelves": () => SHELVES,
    "memory.sources": () => ({
      memoryId: "m-1",
      call: CHRISTMAS,
      sources: [
        {
          sourceId: "s-1",
          kind: "conversation",
          label: "session of 2026-12-27",
          uri: null,
          trust: "stated",
          occurredAt: null,
          createdAt: "2026-12-27T10:00:00.000Z",
          quote: "The oven died, so we ordered pizza.",
          citedBy: 1,
        },
      ],
    }),
    "memory.history": () => ({
      mode: "history",
      memoryId: "m-1",
      call: CHRISTMAS,
      versions: [
        {
          id: "v-1",
          operation: "create",
          actor: "user",
          at: "2026-12-27T10:00:00.000Z",
          contentSha256: "x",
          redacted: false,
          content: { callNumber: CHRISTMAS, shelf: "LIF/GTH", occurredOn: "2026-12-24", title: "Hosted Christmas", body: "", importance: 3, trust: "stated", state: "active", tags: [] },
        },
      ],
      absorbed: [],
    }),
    "memory.related": () => ({
      call: CHRISTMAS,
      memoryId: "m-1",
      items: [
        { id: "m-2", call: "LIF/GTH/2026-12-24/002", title: "Sam Rivera brought a board game", state: "active", sharedTags: ["christmas"], sharedPeople: [], sharedOccasion: false, score: 1, reason: "1 tag" },
      ],
    }),
    ...extra,
  });
}

describe("the memory page", () => {
  it("shows the call number, body, tags, people, occasion, sources with quotes, history and related", async () => {
    memoryHost();
    render(<Memory call={CHRISTMAS} />);

    expect(await screen.findByRole("heading", { level: 1, name: "Hosted Christmas at the Elmwood cottage" })).toBeTruthy();
    expect(screen.getAllByText(CHRISTMAS).length).toBeGreaterThan(0);
    expect(
      screen.getByText("Hosted Christmas for Jane Doe and John Doe at the Elmwood cottage. The oven died, so we ordered pizza."),
    ).toBeTruthy();
    expect(screen.getByText("#christmas")).toBeTruthy();
    expect(screen.getByText("Jane Doe (a name, not linked to a person)")).toBeTruthy();
    expect(screen.getByText("John Doe")).toBeTruthy();
    expect(screen.getByText("Christmas at Elmwood")).toBeTruthy();
    expect(await screen.findByText("The oven died, so we ordered pizza.")).toBeTruthy();
    expect(await screen.findByText("create")).toBeTruthy();
    expect(await screen.findByText("Sam Rivera brought a board game")).toBeTruthy();
    // Trust and kind are words, not chips.
    expect(screen.getByText(/episode, trust stated, importance 3 of 5, active/)).toBeTruthy();
  });

  it("attaches and detaches tags through memory.set_tags", async () => {
    const host = memoryHost({
      "memory.set_tags": () => ({ action: "memory", memoryId: "m-1", call: CHRISTMAS, added: [], removed: [], tags: [], changed: true }),
    });
    render(<Memory call={CHRISTMAS} />);

    fireEvent.change(await screen.findByLabelText("Add tags"), { target: { value: "#Family, travel" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() =>
      expect(host.callsTo("memory.set_tags")[0]).toEqual({ action: "memory", call: CHRISTMAS, attach: ["family", "travel"] }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Remove #hosting" }));
    await waitFor(() =>
      expect(host.callsTo("memory.set_tags")[1]).toEqual({ action: "memory", call: CHRISTMAS, detach: ["hosting"] }),
    );
  });

  it("shelves to another shelf through memory.shelve and follows the new number", async () => {
    const moved = "LIF/TRV/2026-12-24/001";
    const host = memoryHost({
      "memory.shelve": () => ({ action: "move", memory: memoryView(moved), from: CHRISTMAS, to: moved }),
    });
    render(<Memory call={CHRISTMAS} />);

    fireEvent.click(await screen.findByRole("button", { name: "Shelve" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/is kept as an alias/)).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText("Shelf"), { target: { value: "LIF/TRV" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Move to LIF/TRV" }));

    await waitFor(() => expect(host.callsTo("memory.shelve")).toEqual([{ action: "move", call: CHRISTMAS, shelf: "LIF/TRV" }]));
    await waitFor(() => expect(window.location.pathname).toBe(`/memory/${moved}`));
  });

  it("edits as a new version through memory.update", async () => {
    const host = memoryHost({ "memory.update": () => ({ memory: memoryView(), changed: true }) });
    render(<Memory call={CHRISTMAS} />);

    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "Christmas at Elmwood" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save a new version" }));
    await waitFor(() => expect(host.callsTo("memory.update")[0]).toMatchObject({ call: CHRISTMAS, title: "Christmas at Elmwood" }));
  });

  it("names the call number before forgetting, says it will not come back, and sends confirmedByUser", async () => {
    const host = memoryHost({
      "memory.forget": () => ({ forgotten: { memoryId: "m-1", call: CHRISTMAS, retiredNumbers: [CHRISTMAS] }, sourcesDeleted: 1, tagsDeleted: 0 }),
    });
    render(<Memory call={CHRISTMAS} />);

    fireEvent.click(await screen.findByRole("button", { name: "Forget" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: `Forget ${CHRISTMAS}?` })).toBeTruthy();
    expect(within(dialog).getByText(`It will not come back. ${CHRISTMAS} is never issued again.`)).toBeTruthy();
    expect(host.callsTo("memory.forget")).toEqual([]);

    fireEvent.click(within(dialog).getByRole("button", { name: `Forget ${CHRISTMAS}` }));
    await waitFor(() => expect(host.callsTo("memory.forget")).toEqual([{ call: CHRISTMAS, confirmedByUser: true }]));
    await waitFor(() => expect(window.location.pathname).toBe("/library/LIF/GTH"));
  });

  it("retires only after a confirmation that names the call number", async () => {
    const host = memoryHost({ "memory.retire": () => ({ memory: memoryView(CHRISTMAS, { state: "retired" }) }) });
    render(<Memory call={CHRISTMAS} />);

    fireEvent.click(await screen.findByRole("button", { name: "Retire" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: `Retire ${CHRISTMAS}` }));
    await waitFor(() => expect(host.callsTo("memory.retire")).toEqual([{ call: CHRISTMAS }]));
  });

  it("says a forgotten number was forgotten", async () => {
    fakeHost({
      "memory.get": () =>
        new ToolRefusal("not_found", `${CHRISTMAS} was forgotten. Its number points at nothing and is never reissued.`, {
          call: CHRISTMAS,
          forgotten: true,
        }),
    });
    render(<Memory call={CHRISTMAS} />);
    expect(await screen.findByText(/was forgotten\. Its number points at nothing/)).toBeTruthy();
  });
});
