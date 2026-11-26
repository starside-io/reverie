import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { EntryList } from "@/app/components/entry-list";
import { NativeSelect } from "@/app/components/fields";
import { PageHeader } from "@/app/components/page-header";
import { Failure, Loading } from "@/app/components/states";
import { RpcError, rpc } from "@/client";
import { EmptyState } from "@/ds/empty-state";
import { longMonth, today } from "@/lib/format";
import { useRpc } from "@/lib/use-rpc";
import type { AboutResult, BrowseResult, EntryView, TagsResult } from "@/types";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Label } from "@/ui/label";

/**
 * The timeline (docs/SPEC.md section 20): every shelf merged on one axis,
 * one month at a time, filtered by tag or by person.
 *
 * memory.browse walks by call number, which sorts by section before day, so
 * a month is read whole (every page of browse { from, to }) and put in day
 * order here. A person filter reads memory.about instead, which matches a
 * module:// URI or a name kept unresolved, newest first, at most 200.
 */

/** Pages of 100 read for one month before stopping. 2000 entries a month is past personal scale. */
const MAX_PAGES = 20;

export function shiftMonth(month: string, by: number): string {
  const [year, index] = month.split("-").map(Number) as [number, number];
  const date = new Date(Date.UTC(year, index - 1 + by, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function lastDay(month: string): string {
  const [year, index] = month.split("-").map(Number) as [number, number];
  const day = new Date(Date.UTC(year, index, 0)).getUTCDate();
  return `${month}-${String(day).padStart(2, "0")}`;
}

/** Day order across shelves; within a day, call number order. */
export function onOneAxis<T extends { occurredOn: string; call: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) =>
    a.occurredOn < b.occurredOn ? -1 : a.occurredOn > b.occurredOn ? 1 : a.call < b.call ? -1 : a.call > b.call ? 1 : 0,
  );
}

export function Timeline() {
  const tags = useRpc<TagsResult>("memory.tags");
  const [month, setMonth] = useState(today().slice(0, 7));
  const [tag, setTag] = useState("");
  const [person, setPerson] = useState("");
  const [asked, setAsked] = useState("");
  const [items, setItems] = useState<EntryView[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<RpcError | undefined>(undefined);

  useEffect(() => {
    let live = true;
    const from = `${month}-01`;
    const to = lastDay(month);
    setItems(null);
    setError(undefined);
    setTruncated(false);

    const load = async (): Promise<{ items: EntryView[]; truncated: boolean }> => {
      if (asked) {
        const about = await rpc<AboutResult>("memory.about", { person: asked, limit: 200 });
        const kept = about.items.filter(
          (item) => item.occurredOn >= from && item.occurredOn <= to && (!tag || item.tags.includes(tag)),
        );
        return { items: kept, truncated: about.total > about.items.length };
      }
      const out: EntryView[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const answer: BrowseResult = await rpc<BrowseResult>("memory.browse", {
          from,
          to,
          limit: 100,
          ...(tag ? { tags: [tag] } : {}),
          ...(cursor ? { cursor } : {}),
        });
        out.push(...answer.items);
        cursor = answer.nextCursor;
        if (!cursor) return { items: out, truncated: false };
      }
      return { items: out, truncated: true };
    };

    load()
      .then((answer) => {
        if (!live) return;
        setItems(onOneAxis(answer.items));
        setTruncated(answer.truncated);
      })
      .catch((caught: unknown) => {
        if (live) setError(caught instanceof RpcError ? caught : new RpcError("memory.browse", "failed", String(caught)));
      });
    return () => {
      live = false;
    };
  }, [month, tag, asked]);

  return (
    <div className="space-y-5">
      <PageHeader title="Timeline" description="Every shelf on one axis, by the day things happened." />

      <div className="bg-card flex flex-wrap items-end gap-3 rounded-lg border p-3">
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" aria-label="Previous month" onClick={() => setMonth(shiftMonth(month, -1))}>
            <ChevronLeft aria-hidden />
          </Button>
          <Input
            aria-label="Month"
            type="month"
            value={month}
            onChange={(event) => event.target.value && setMonth(event.target.value)}
            className="w-40"
          />
          <Button variant="ghost" size="icon" aria-label="Next month" onClick={() => setMonth(shiftMonth(month, 1))}>
            <ChevronRight aria-hidden />
          </Button>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="timeline-tag">Tag</Label>
          <NativeSelect id="timeline-tag" value={tag} onChange={(event) => setTag(event.target.value)} className="w-44">
            <option value="">Any tag</option>
            {(tags.data?.tags ?? []).map((entry) => (
              <option key={entry.slug} value={entry.slug}>
                #{entry.slug} ({entry.count})
              </option>
            ))}
          </NativeSelect>
        </div>
        <form
          className="flex items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            setAsked(person.trim());
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="timeline-person">Person</Label>
            <Input
              id="timeline-person"
              placeholder="Jane Doe, or a module:// URI"
              value={person}
              onChange={(event) => setPerson(event.target.value)}
              className="w-64"
            />
          </div>
          <Button type="submit" variant="outline">
            Filter
          </Button>
          {asked ? (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setPerson("");
                setAsked("");
              }}
            >
              Clear
            </Button>
          ) : null}
        </form>
      </div>

      <h2 className="font-heading text-lg font-semibold">
        {longMonth(month)}
        {tag ? `, #${tag}` : ""}
        {asked ? `, with ${asked}` : ""}
      </h2>
      {error ? <Failure error={error} /> : null}
      {!items && !error ? <Loading lines={4} /> : null}
      {items && items.length === 0 ? <EmptyState size="sm" title="Nothing that month" /> : null}
      {items && items.length > 0 ? <EntryList items={items} showShelf /> : null}
      {truncated ? (
        <p className="text-muted-foreground text-sm">
          {asked
            ? "More entries carry this person than one read returns (200). Older ones may be missing."
            : "This month holds more than this screen reads at once. Some entries are not shown."}
        </p>
      ) : null}
    </div>
  );
}
