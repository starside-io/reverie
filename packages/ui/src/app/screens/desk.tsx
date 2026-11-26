import { useState } from "react";

import { CallNumber, ShelfSelect } from "@/app/components/fields";
import { PageHeader } from "@/app/components/page-header";
import { Failure, Loading } from "@/app/components/states";
import { SectionCard } from "@/ds/section-card";
import { longDay } from "@/lib/format";
import { memoryHref, useLinkHandler } from "@/lib/router";
import { useRpc, useWrite } from "@/lib/use-rpc";
import type {
  BrowseResult,
  ConflictsResult,
  EntryView,
  ReviewResult,
  SectionEntry,
  ShelvesResult,
  StaleResult,
} from "@/types";
import { Button } from "@/ui/button";

/**
 * The front desk (docs/SPEC.md section 20): returns to shelve, occasions
 * with no story yet, unresolved names, stale entries and conflicts.
 *
 *   Returns                  memory.browse { shelf: "DSK/RET" }, shelved with memory.shelve
 *   occasions, names         memory.review's frontDesk
 *   stale                    memory.stale, "Still true" is memory.touch
 *   conflicts                memory.conflicts
 */

export const RETURNS = "DSK/RET";

export function FrontDesk() {
  const shelves = useRpc<ShelvesResult>("memory.shelves");
  const returns = useRpc<BrowseResult>("memory.browse", { shelf: RETURNS, limit: 100 });
  const review = useRpc<ReviewResult>("memory.review", { state: "pending" });
  const stale = useRpc<StaleResult>("memory.stale", { limit: 50 });
  const conflicts = useRpc<ConflictsResult>("memory.conflicts", { limit: 50 });
  const onLink = useLinkHandler();
  const desk = review.data?.frontDesk;
  const sections = (shelves.data?.sections ?? []).map((section) => ({
    ...section,
    shelves: section.shelves.filter((shelf) => shelf.path !== RETURNS),
  }));

  return (
    <div className="space-y-6">
      <PageHeader title="Front desk" description="What is waiting for a decision that is not a proposal." />

      <SectionCard
        title="Returns to shelve"
        description="Entries that arrived with no shelf. Shelving one gives it a new call number and keeps the old one as an alias."
      >
        {returns.error ? <Failure error={returns.error} /> : null}
        {returns.loading ? <Loading lines={2} /> : null}
        {returns.data && returns.data.items.length === 0 ? (
          <p className="text-muted-foreground text-sm">Nothing is waiting on Returns.</p>
        ) : null}
        <ul className="divide-border divide-y">
          {(returns.data?.items ?? []).map((item) => (
            <ReturnRow key={item.id} item={item} sections={sections} />
          ))}
        </ul>
      </SectionCard>

      <div className="grid gap-6 lg:grid-cols-2">
        <SectionCard title="Occasions with no story yet" description="Logged in the people module, told by no memory here.">
          {review.error ? <Failure error={review.error} /> : null}
          {desk?.notice ? <p className="text-muted-foreground text-sm">{desk.notice}</p> : null}
          {desk && desk.occasionsWithNoStory.length === 0 && desk.occasionPending.length === 0 ? (
            <p className="text-muted-foreground text-sm">None.</p>
          ) : null}
          <ul className="space-y-2 text-sm">
            {(desk?.occasionsWithNoStory ?? []).map((entry) => (
              <li key={entry.occasion}>
                <p>
                  {entry.title ?? "An occasion"}
                  {entry.occurredOn ? `, ${longDay(entry.occurredOn)}` : ""}
                </p>
                <p className="text-muted-foreground font-mono text-xs break-all">{entry.occasion}</p>
              </li>
            ))}
          </ul>
          {desk && desk.occasionPending.length > 0 ? (
            <>
              <h3 className="mt-4 text-sm font-medium">Occasion pending</h3>
              <p className="text-muted-foreground text-xs">
                Episodes whose occasion was confirmed here but not yet logged in the people module.
              </p>
              <ul className="mt-2 space-y-2 text-sm">
                {desk.occasionPending.map((entry) => (
                  <li key={entry.call}>
                    <a href={memoryHref(entry.call)} onClick={onLink} className="hover:underline">
                      <CallNumber call={entry.call} className="text-muted-foreground mr-2" />
                      {entry.title}
                    </a>
                    <span className="text-muted-foreground block text-xs">
                      {entry.occasion.title}, {entry.occasion.type}, {entry.occasion.occurredAt}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </SectionCard>

        <SectionCard title="Unresolved names" description="Names kept as told, never matched to a person here.">
          {desk && desk.unresolvedNames.length === 0 ? <p className="text-muted-foreground text-sm">None.</p> : null}
          <ul className="space-y-2 text-sm">
            {(desk?.unresolvedNames ?? []).map((entry) => (
              <li key={entry.name}>
                <p className="font-medium">{entry.name}</p>
                <p className="flex flex-wrap gap-x-3">
                  {entry.calls.map((call) => (
                    <a key={call} href={memoryHref(call)} onClick={onLink} className="text-muted-foreground hover:underline">
                      <CallNumber call={call} />
                    </a>
                  ))}
                </p>
              </li>
            ))}
          </ul>
        </SectionCard>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <SectionCard
          title="Stale entries"
          description={
            stale.data
              ? `Active entries not confirmed in ${stale.data.staleAfterDays} days, oldest first.`
              : "Active entries not confirmed in a while."
          }
        >
          {stale.error ? <Failure error={stale.error} /> : null}
          {stale.data && stale.data.items.length === 0 ? <p className="text-muted-foreground text-sm">None.</p> : null}
          <ul className="divide-border divide-y">
            {(stale.data?.items ?? []).map((item) => (
              <StaleRow key={item.id} item={item} />
            ))}
          </ul>
          {stale.data && stale.data.total > stale.data.items.length ? (
            <p className="text-muted-foreground mt-2 text-xs">
              {stale.data.total} in all; the oldest {stale.data.items.length} are shown.
            </p>
          ) : null}
        </SectionCard>

        <SectionCard title="Conflicts" description="Pairs marked as contradicting each other.">
          {conflicts.error ? <Failure error={conflicts.error} /> : null}
          {conflicts.data && conflicts.data.pairs.length === 0 ? (
            <p className="text-muted-foreground text-sm">None.</p>
          ) : null}
          <ul className="space-y-3 text-sm">
            {(conflicts.data?.pairs ?? []).map((pair) => (
              <li key={pair.linkId}>
                <a href={memoryHref(pair.from.call)} onClick={onLink} className="block hover:underline">
                  <CallNumber call={pair.from.call} className="text-muted-foreground mr-2" />
                  {pair.from.title}
                </a>
                <span className="text-muted-foreground block text-xs">contradicts</span>
                <a href={memoryHref(pair.to.call)} onClick={onLink} className="block hover:underline">
                  <CallNumber call={pair.to.call} className="text-muted-foreground mr-2" />
                  {pair.to.title}
                </a>
              </li>
            ))}
          </ul>
        </SectionCard>
      </div>
    </div>
  );
}

function ReturnRow({ item, sections }: { item: EntryView; sections: readonly SectionEntry[] }) {
  const onLink = useLinkHandler();
  const write = useWrite("memory.shelve");
  const [shelf, setShelf] = useState("");
  return (
    <li className="space-y-2 py-3">
      <a href={memoryHref(item.call)} onClick={onLink} className="block hover:underline">
        <CallNumber call={item.call} className="text-muted-foreground mr-2" />
        <span className="font-medium">{item.title}</span>
      </a>
      <p className="text-muted-foreground text-sm">{item.excerpt}</p>
      <form
        className="flex max-w-lg gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (shelf) void write.run({ action: "move", call: item.call, shelf });
        }}
      >
        <ShelfSelect
          aria-label={`Shelf for ${item.call}`}
          sections={sections}
          value={shelf}
          onChange={(event) => setShelf(event.target.value)}
          emptyLabel="Choose a shelf"
        />
        <Button type="submit" variant="outline" disabled={!shelf || write.pending}>
          Shelve
        </Button>
      </form>
      {write.error ? <Failure error={write.error} /> : null}
    </li>
  );
}

function StaleRow({ item }: { item: EntryView & { daysSinceConfirmed: number } }) {
  const onLink = useLinkHandler();
  const write = useWrite("memory.touch");
  return (
    <li className="flex items-start justify-between gap-3 py-2 text-sm">
      <a href={memoryHref(item.call)} onClick={onLink} className="min-w-0 hover:underline">
        <CallNumber call={item.call} className="text-muted-foreground block" />
        <span className="block truncate">{item.title}</span>
        <span className="text-muted-foreground block text-xs">confirmed {item.daysSinceConfirmed} days ago</span>
      </a>
      <Button variant="outline" size="sm" disabled={write.pending} onClick={() => void write.run({ call: item.call })}>
        Still true
      </Button>
    </li>
  );
}
