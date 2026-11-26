import { useEffect, useState } from "react";
import { Plus } from "lucide-react";

import { EntryList } from "@/app/components/entry-list";
import { PageHeader } from "@/app/components/page-header";
import { RememberDialog } from "@/app/components/remember-dialog";
import { Failure, Loading, Spinner } from "@/app/components/states";
import { RpcError, rpc } from "@/client";
import { EmptyState } from "@/ds/empty-state";
import { cn } from "@/lib/cn";
import { shelfHref, useLinkHandler } from "@/lib/router";
import { useRpc } from "@/lib/use-rpc";
import type { BrowseResult, EntryView, SectionEntry, ShelvesResult } from "@/types";
import { Button } from "@/ui/button";

/**
 * The home screen (docs/SPEC.md section 20): sections down the side, the
 * section's shelves across, and one shelf opened as a dated list in call
 * number order. memory.shelves for the building, memory.browse for the shelf.
 */

const PAGE = 50;

export function Library({ section, shelf }: { section: string | null; shelf: string | null }) {
  const shelves = useRpc<ShelvesResult>("memory.shelves");
  const onLink = useLinkHandler();
  const [adding, setAdding] = useState(false);

  if (shelves.error) return <Failure error={shelves.error} />;
  if (!shelves.data) return <Loading lines={6} />;

  const sections = shelves.data.sections;
  const openSection =
    sections.find((entry) => entry.code === section) ??
    (shelf ? sections.find((entry) => shelf.startsWith(`${entry.code}/`)) : undefined) ??
    sections.find((entry) => entry.count > 0) ??
    sections[0];
  const openShelf =
    openSection?.shelves.find((entry) => entry.path === shelf) ??
    openSection?.shelves.find((entry) => entry.count > 0) ??
    openSection?.shelves[0];

  return (
    <div>
      <PageHeader
        title="Library"
        description="Each memory has one home on a shelf. A shelf read top to bottom is a timeline: its call numbers sort by day, then by order within the day."
        action={
          <Button onClick={() => setAdding(true)}>
            <Plus aria-hidden /> Remember
          </Button>
        }
      />

      <div className="grid gap-6 md:grid-cols-[13rem_minmax(0,1fr)]">
        <aside aria-label="Sections">
          <ul className="space-y-0.5">
            {sections.map((entry) => (
              <li key={entry.code}>
                <a
                  href={`/library/${entry.code}`}
                  onClick={onLink}
                  aria-current={entry.code === openSection?.code ? "true" : undefined}
                  className={cn(
                    "flex items-baseline justify-between gap-2 rounded-md px-2.5 py-1.5 text-sm",
                    entry.code === openSection?.code ? "bg-accent font-medium" : "hover:bg-muted",
                  )}
                >
                  <span>
                    <span className="text-muted-foreground mr-2 font-mono text-xs">{entry.code}</span>
                    {entry.name}
                  </span>
                  <span className="text-muted-foreground text-xs tabular-nums">{entry.count}</span>
                </a>
              </li>
            ))}
          </ul>
        </aside>

        <div className="min-w-0 space-y-5">
          {openSection ? <ShelfRow section={openSection} open={openShelf?.path ?? null} /> : null}
          {openShelf ? (
            <ShelfPage path={openShelf.path} name={openShelf.name} description={openShelf.description} />
          ) : (
            <EmptyState title="No shelves in this section" description="Shelves are made with memory.set_shelves." />
          )}
        </div>
      </div>

      {adding ? (
        <RememberDialog
          open={adding}
          onOpenChange={setAdding}
          sections={sections}
          shelf={openShelf?.path ?? null}
        />
      ) : null}
    </div>
  );
}

function ShelfRow({ section, open }: { section: SectionEntry; open: string | null }) {
  const onLink = useLinkHandler();
  return (
    <nav aria-label={`Shelves in ${section.name}`} className="flex gap-2 overflow-x-auto pb-1">
      {section.shelves.map((entry) => (
        <a
          key={entry.path}
          href={shelfHref(entry.path)}
          onClick={onLink}
          aria-current={entry.path === open ? "true" : undefined}
          className={cn(
            "bg-card min-w-36 shrink-0 rounded-lg border px-3 py-2 text-sm",
            entry.path === open ? "border-primary ring-primary/30 ring-2" : "hover:bg-muted/60",
          )}
        >
          <span className="text-muted-foreground block font-mono text-xs">{entry.path}</span>
          <span className="block font-medium">{entry.name}</span>
          <span className="text-muted-foreground block text-xs tabular-nums">
            {entry.count} active{entry.total > entry.count ? `, ${entry.total} in all` : ""}
          </span>
        </a>
      ))}
    </nav>
  );
}

/** One shelf, paged with browse's cursor. */
export function ShelfPage({ path, name, description }: { path: string; name: string; description: string }) {
  const [order, setOrder] = useState<"asc" | "desc">("asc");
  const [includeRetired, setIncludeRetired] = useState(false);
  const input = { shelf: path, order, includeRetired, limit: PAGE };
  const first = useRpc<BrowseResult>("memory.browse", input);
  const [more, setMore] = useState<EntryView[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<RpcError | undefined>(undefined);

  // A new first page starts the list again.
  useEffect(() => {
    setMore([]);
    setCursor(first.data?.nextCursor ?? null);
  }, [first.data]);

  const loadMore = async () => {
    if (!cursor) return;
    setLoadingMore(true);
    setMoreError(undefined);
    try {
      const page = await rpc<BrowseResult>("memory.browse", { ...input, cursor });
      setMore((current) => [...current, ...page.items]);
      setCursor(page.nextCursor);
    } catch (error) {
      setMoreError(error instanceof RpcError ? error : new RpcError("memory.browse", "failed", String(error)));
    } finally {
      setLoadingMore(false);
    }
  };

  const items = [...(first.data?.items ?? []), ...more];

  return (
    <section aria-label={`Shelf ${path}`} className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-heading text-lg font-semibold">
            <span className="text-muted-foreground mr-2 font-mono text-sm">{path}</span>
            {name}
          </h2>
          <p className="text-muted-foreground text-sm">{description}</p>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={includeRetired}
              onChange={(event) => setIncludeRetired(event.target.checked)}
            />
            Include the stacks (retired)
          </label>
          <Button variant="outline" size="sm" onClick={() => setOrder(order === "asc" ? "desc" : "asc")}>
            {order === "asc" ? "Oldest first" : "Newest first"}
          </Button>
        </div>
      </div>

      {first.error ? <Failure error={first.error} /> : null}
      {first.loading ? <Loading lines={4} /> : null}
      {first.data && items.length === 0 ? (
        <EmptyState size="sm" title="Nothing on this shelf yet" description="An empty shelf is an empty page." />
      ) : null}
      {items.length > 0 ? <EntryList items={items} /> : null}
      {moreError ? <Failure error={moreError} /> : null}
      {cursor ? (
        <div className="flex justify-center">
          {loadingMore ? (
            <Spinner label="Loading" />
          ) : (
            <Button variant="outline" onClick={() => void loadMore()}>
              Load more
            </Button>
          )}
        </div>
      ) : null}
    </section>
  );
}
