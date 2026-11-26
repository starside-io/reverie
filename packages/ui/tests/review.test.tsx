import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Review } from "@/app/screens/review";
import { fakeHost } from "./fake-host";

const SAID = "We met Sam Rivera for coffee at the station cafe in Elmwood.";

function proposal(id: string, group: { id: string; title: string } | null, extra: Record<string, unknown> = {}) {
  return {
    id,
    tool: "memory.remember",
    payload: {
      kind: "episode",
      title: "Coffee with Sam",
      body: "Met Sam Rivera for coffee at the station cafe in Elmwood.",
      shelf: "LIF/GTH",
      occurredOn: "2026-12-27",
      tags: ["coffee"],
      attendees: ["Sam Rivera"],
      draft: { job: "extract", quote: SAID, source: { kind: "conversation", label: "session of 2026-12-27" }, newTags: ["coffee"] },
    },
    summary: "New episode on LIF/GTH, 2026-12-27: Coffee with Sam",
    memoryId: null,
    call: null,
    group,
    state: "pending",
    createdAt: "2026-12-27T10:00:00.000Z",
    decidedAt: null,
    ...extra,
  };
}

const EMPTY_DESK = { occasionPending: [], occasionsWithNoStory: [], unresolvedNames: [], notice: null };

function review(proposals: unknown[], groups: unknown[] = []) {
  return { state: "pending", proposals, groups, frontDesk: EMPTY_DESK };
}

describe("the review screen", () => {
  it("groups proposals by session or event, each with its verb, proposed shelf and quote", async () => {
    const session = { id: "session:a:2026-12-27", title: "Session of 2026-12-27" };
    const event = { id: "event:e1", title: "Christmas at Elmwood" };
    fakeHost({
      "memory.review": () =>
        review(
          [
            proposal("p1", session),
            proposal("p2", event, {
              tool: "memory.update",
              payload: { call: "LIF/HOM/2026-11-02/001", body: "Prefers oat milk.", draft: { job: "reconcile", quote: "Oat milk, always." } },
              summary: "Refine LIF/HOM/2026-11-02/001",
            }),
          ],
          [
            { id: session.id, title: session.title, detail: null, steps: [] },
            { id: event.id, title: event.title, detail: null, steps: [] },
          ],
        ),
    });
    render(<Review />);

    const first = await screen.findByRole("region", { name: "Session of 2026-12-27" });
    expect(within(first).getByText("Add")).toBeTruthy();
    expect(within(first).getByText("on LIF/GTH")).toBeTruthy();
    expect(within(first).getByText(SAID)).toBeTruthy();
    expect(within(first).getByText(/#coffee \(new tag\)/)).toBeTruthy();

    const second = screen.getByRole("region", { name: "Christmas at Elmwood" });
    expect(within(second).getByText("Refine")).toBeTruthy();
    expect(within(second).getByText("on LIF/HOM")).toBeTruthy();
    expect(within(second).getByText("Oat milk, always.")).toBeTruthy();
  });

  it("confirms through the mini-host's decision route and shows where it was shelved", async () => {
    let decided = false;
    const host = fakeHost(
      { "memory.review": () => review(decided ? [] : [proposal("p1", null)]) },
      {
        decide: () => {
          decided = true;
          return { status: 200, body: { ok: true, state: "confirmed", committed: { call: "LIF/GTH/2026-12-27/001" } } };
        },
      },
    );
    render(<Review />);

    fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(host.decisions).toEqual([{ id: "p1", decision: "confirm" }]));
    const done = await screen.findByRole("region", { name: "Decided just now" });
    expect(within(done).getByText(/Confirmed: Coffee with Sam/)).toBeTruthy();
    expect(within(done).getByText("LIF/GTH/2026-12-27/001")).toBeTruthy();
    expect(await screen.findByText("Nothing is waiting")).toBeTruthy();
  });

  it("rejects through the same route and writes nothing", async () => {
    const host = fakeHost({ "memory.review": () => review([proposal("p1", null)]) });
    render(<Review />);
    fireEvent.click(await screen.findByRole("button", { name: "Reject" }));
    await waitFor(() => expect(host.decisions).toEqual([{ id: "p1", decision: "reject" }]));
    expect(host.callsTo("memory.remember")).toEqual([]);
  });

  it("keeps a refused proposal waiting and says why", async () => {
    fakeHost(
      { "memory.review": () => review([proposal("p1", null)]) },
      {
        decide: () => ({
          status: 409,
          body: { ok: false, error: { code: "refused", message: "The proposed memory.remember was refused, so nothing was written and the proposal stays pending: duplicate." } },
        }),
      },
    );
    render(<Review />);
    fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/stays pending/);
    expect(screen.getByRole("button", { name: "Confirm" })).toBeTruthy();
  });

  it("decides the parts riding inside a proposal one by one, through memory.decide", async () => {
    const group = { id: "event:e2", title: "Dinner at Port Calder" };
    const host = fakeHost({
      "memory.review": () =>
        review(
          [proposal("p1", group)],
          [
            {
              id: group.id,
              title: group.title,
              detail: null,
              steps: [
                { step: 1, part: "occasion", proposalId: "p1", tool: "people.log_interaction", summary: "Occasion: Dinner, dinner, 2026-12-27, with Sam Rivera" },
                { step: 2, part: "memory", proposalId: "p1", tool: "memory.remember", summary: "New episode" },
                { step: 3, part: "note", proposalId: "p1", noteIndex: 0, tool: "people.add_note", summary: "Note on Sam Rivera: moved to Port Calder" },
              ],
            },
          ],
        ),
      "memory.decide": () => ({ state: "confirmed", committed: { call: "LIF/GTH/2026-12-27/001" } }),
    });
    render(<Review />);

    const note = await screen.findByLabelText(/Note on Sam Rivera/);
    fireEvent.click(note);
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() =>
      expect(host.callsTo("memory.decide")).toEqual([
        { proposalId: "p1", decision: "confirm", pending: { occasion: "confirm", notes: ["reject"] }, confirmedByUser: true },
      ]),
    );
  });
});
