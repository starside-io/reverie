import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Tags } from "@/app/screens/tags";
import { entry, fakeHost } from "./fake-host";

function tagsHost(extra: Record<string, (input: Record<string, unknown>) => unknown> = {}) {
  return fakeHost({
    "memory.tags": () => ({
      tags: [
        { slug: "christmas", colour: "#c8955a", count: 3 },
        { slug: "xmas", colour: "#c8955a", count: 1 },
      ],
    }),
    "memory.browse": () => ({
      notice: "",
      order: "desc",
      items: [entry("LIF/GTH/2026-12-24/001", "Hosted Christmas", { tags: ["xmas"] })],
      nextCursor: null,
      anchor: null,
    }),
    ...extra,
  });
}

describe("the tags screen", () => {
  it("lists the vocabulary with counts and what carries a tag", async () => {
    const host = tagsHost();
    render(<Tags />);
    const list = await screen.findByRole("list", { name: "Tag vocabulary" });
    expect(within(list).getByText("#christmas")).toBeTruthy();
    expect(within(list).getByText("3")).toBeTruthy();

    fireEvent.click(within(list).getByText("#xmas"));
    expect(await screen.findByText("Hosted Christmas")).toBeTruthy();
    expect(host.callsTo("memory.browse")[0]).toMatchObject({ tags: ["xmas"] });
  });

  it("merges one tag into another through memory.set_tags, after saying what moves", async () => {
    const host = tagsHost({ "memory.set_tags": () => ({ action: "merge", from: "xmas", into: "christmas", moved: 1, alreadyTagged: 0 }) });
    render(<Tags />);
    fireEvent.click(await screen.findByText("#xmas"));
    fireEvent.change(screen.getByLabelText("Merge into"), { target: { value: "christmas" } });
    fireEvent.click(screen.getByRole("button", { name: "Merge" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/The one memory tagged #xmas is tagged #christmas instead/)).toBeTruthy();
    expect(host.callsTo("memory.set_tags")).toEqual([]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Merge into #christmas" }));
    await waitFor(() => expect(host.callsTo("memory.set_tags")).toEqual([{ action: "merge", from: "xmas", into: "christmas" }]));
    expect(await screen.findByText("Merged #xmas into #christmas.")).toBeTruthy();
  });

  it("renames a tag, normalising what was typed", async () => {
    const host = tagsHost({ "memory.set_tags": () => ({ action: "rename", from: "xmas", to: "holidays", memories: 1 }) });
    render(<Tags />);
    fireEvent.click(await screen.findByText("#xmas"));
    fireEvent.change(screen.getByLabelText("New name"), { target: { value: "#Holidays" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Rename to #holidays" }));
    await waitFor(() => expect(host.callsTo("memory.set_tags")).toEqual([{ action: "rename", from: "xmas", to: "holidays" }]));
  });
});
