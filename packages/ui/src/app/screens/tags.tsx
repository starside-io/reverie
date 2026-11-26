import { useState } from "react";

import { ConfirmDialog } from "@/app/components/confirm";
import { EntryList } from "@/app/components/entry-list";
import { NativeSelect } from "@/app/components/fields";
import { PageHeader } from "@/app/components/page-header";
import { Failure, Loading } from "@/app/components/states";
import { EmptyState } from "@/ds/empty-state";
import { SectionCard } from "@/ds/section-card";
import { cn } from "@/lib/cn";
import { slugOf } from "@/lib/format";
import { useRpc, useWrite } from "@/lib/use-rpc";
import type { BrowseResult, TagsResult } from "@/types";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Label } from "@/ui/label";

/**
 * Tags (docs/SPEC.md sections 6 and 20): the vocabulary with counts, and
 * merge and rename, both memory.set_tags. Neither rewrites a body: they move
 * the join rows. Selecting a tag shows what carries it, through
 * memory.browse { tags }.
 */

type Pending = { action: "rename"; from: string; to: string } | { action: "merge"; from: string; into: string; count: number };

export function Tags() {
  const tags = useRpc<TagsResult>("memory.tags");
  const write = useWrite<{ action: string }>("memory.set_tags");
  const [selected, setSelected] = useState<string | null>(null);
  const [renameTo, setRenameTo] = useState("");
  const [mergeInto, setMergeInto] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [done, setDone] = useState<string | null>(null);

  if (tags.error) return <Failure error={tags.error} />;
  if (!tags.data) return <Loading lines={6} />;

  const vocabulary = tags.data.tags;
  const current = vocabulary.find((entry) => entry.slug === selected) ?? null;

  const apply = async () => {
    if (!pending) return;
    const result =
      pending.action === "rename"
        ? await write.run({ action: "rename", from: pending.from, to: pending.to })
        : await write.run({ action: "merge", from: pending.from, into: pending.into });
    if (result) {
      setDone(
        pending.action === "rename"
          ? `Renamed #${pending.from} to #${pending.to}.`
          : `Merged #${pending.from} into #${pending.into}.`,
      );
      setSelected(pending.action === "rename" ? pending.to : pending.into);
      setPending(null);
      setRenameTo("");
      setMergeInto("");
    }
  };

  return (
    <div>
      <PageHeader
        title="Tags"
        description="One vocabulary of lowercase slugs that cut across shelves. Renaming and merging move the tags on memories and rewrite no body."
      />
      {done ? (
        <p className="bg-muted/50 mb-4 rounded-lg border p-3 text-sm" role="status">
          {done}
        </p>
      ) : null}
      {vocabulary.length === 0 ? (
        <EmptyState title="No tags yet" description="Tags arrive with memories: written inline as #tag, or added on a memory's page." />
      ) : (
        <div className="grid gap-6 md:grid-cols-[16rem_minmax(0,1fr)]">
          <ul aria-label="Tag vocabulary" className="bg-card divide-border h-fit divide-y rounded-lg border text-sm">
            {vocabulary.map((entry) => (
              <li key={entry.slug}>
                <button
                  type="button"
                  onClick={() => {
                    setSelected(entry.slug);
                    setDone(null);
                  }}
                  aria-current={entry.slug === selected ? "true" : undefined}
                  className={cn(
                    "flex w-full items-baseline justify-between px-3 py-2 text-left",
                    entry.slug === selected ? "bg-accent font-medium" : "hover:bg-muted/60",
                  )}
                >
                  <span>#{entry.slug}</span>
                  <span className="text-muted-foreground tabular-nums">{entry.count}</span>
                </button>
              </li>
            ))}
          </ul>

          {current ? (
            <div className="min-w-0 space-y-5">
              <h2 className="font-heading text-lg font-semibold">
                #{current.slug}{" "}
                <span className="text-muted-foreground text-sm font-normal">
                  on {current.count} {current.count === 1 ? "memory" : "memories"}
                </span>
              </h2>
              <div className="grid gap-4 lg:grid-cols-2">
                <SectionCard title="Rename" description="Every memory keeps it, under the new name.">
                  <form
                    className="grid gap-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const to = slugOf(renameTo);
                      if (to && to !== current.slug) setPending({ action: "rename", from: current.slug, to });
                    }}
                  >
                    <Label htmlFor="tag-rename">New name</Label>
                    <Input id="tag-rename" value={renameTo} onChange={(event) => setRenameTo(event.target.value)} />
                    <Button type="submit" variant="outline" disabled={!slugOf(renameTo) || slugOf(renameTo) === current.slug}>
                      Rename
                    </Button>
                  </form>
                </SectionCard>
                <SectionCard title="Merge" description="Fold it into another tag. It leaves the vocabulary.">
                  <form
                    className="grid gap-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (mergeInto) setPending({ action: "merge", from: current.slug, into: mergeInto, count: current.count });
                    }}
                  >
                    <Label htmlFor="tag-merge">Merge into</Label>
                    <NativeSelect id="tag-merge" value={mergeInto} onChange={(event) => setMergeInto(event.target.value)}>
                      <option value="">Choose a tag</option>
                      {vocabulary
                        .filter((entry) => entry.slug !== current.slug)
                        .map((entry) => (
                          <option key={entry.slug} value={entry.slug}>
                            #{entry.slug} ({entry.count})
                          </option>
                        ))}
                    </NativeSelect>
                    <Button type="submit" variant="outline" disabled={!mergeInto}>
                      Merge
                    </Button>
                  </form>
                </SectionCard>
              </div>
              <Tagged slug={current.slug} />
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">Pick a tag to see what carries it, or to rename or merge it.</p>
          )}
        </div>
      )}

      {pending ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setPending(null);
          }}
          title={pending.action === "rename" ? `Rename #${pending.from}?` : `Merge #${pending.from} into #${pending.into}?`}
          action={pending.action === "rename" ? `Rename to #${pending.to}` : `Merge into #${pending.into}`}
          pending={write.pending}
          error={write.error}
          onConfirm={() => void apply()}
        >
          {pending.action === "rename" ? (
            <p>
              #{pending.from} becomes #{pending.to} on every memory that carries it. If #{pending.to} already exists, the
              host refuses and nothing changes: merge instead.
            </p>
          ) : (
            <p>
              {pending.count === 1
                ? `The one memory tagged #${pending.from} is tagged #${pending.into} instead`
                : `The ${pending.count} memories tagged #${pending.from} are tagged #${pending.into} instead`}
              {`, and #${pending.from} is removed from the vocabulary. Bodies are not rewritten, so an inline #${pending.from} in a body stays as written.`}
            </p>
          )}
        </ConfirmDialog>
      ) : null}
    </div>
  );
}

function Tagged({ slug }: { slug: string }) {
  const browse = useRpc<BrowseResult>("memory.browse", { tags: [slug], order: "desc", limit: 50 });
  if (browse.error) return <Failure error={browse.error} />;
  if (!browse.data) return <Loading lines={3} />;
  return (
    <section aria-label={`Tagged #${slug}`} className="space-y-2">
      <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">Carrying it, newest call number first</h3>
      {browse.data.items.length === 0 ? (
        <p className="text-muted-foreground text-sm">No active memory carries it.</p>
      ) : (
        <EntryList items={browse.data.items} showShelf />
      )}
      {browse.data.nextCursor ? <p className="text-muted-foreground text-sm">Showing the first 50.</p> : null}
    </section>
  );
}
