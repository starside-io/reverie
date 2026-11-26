import { CallNumber } from "@/app/components/fields";
import { byDay, longDay } from "@/lib/format";
import { memoryHref, useLinkHandler } from "@/lib/router";
import type { EntryView } from "@/types";

/**
 * Entries as a dated list: a heading per day, the entries of that day under
 * it in the order they came. Trust, kind and state are words, not chips.
 */
export function EntryList({ items, showShelf = false }: { items: readonly EntryView[]; showShelf?: boolean }) {
  const onLink = useLinkHandler();
  return (
    <div className="space-y-5">
      {byDay(items).map((group) => (
        <section key={group.day} aria-label={longDay(group.day)}>
          <h3 className="text-muted-foreground mb-1.5 text-xs font-medium tracking-wide uppercase">
            {longDay(group.day)}
          </h3>
          <ul className="divide-border bg-card divide-y rounded-lg border">
            {group.items.map((item) => (
              <li key={item.id}>
                <a
                  href={memoryHref(item.call)}
                  onClick={onLink}
                  className="hover:bg-muted/60 flex flex-col gap-0.5 px-3 py-2.5 sm:flex-row sm:items-baseline sm:gap-4"
                >
                  <CallNumber call={item.call} className="text-muted-foreground shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{item.title}</span>
                    <span className="text-muted-foreground line-clamp-2 block text-sm">{item.excerpt}</span>
                    <span className="text-muted-foreground mt-0.5 block text-xs">
                      {[
                        showShelf ? item.shelf : null,
                        item.kind,
                        `trust ${item.trust}`,
                        item.state === "active" ? null : item.state,
                        item.pinned ? "pinned" : null,
                        ...item.tags.map((tag) => `#${tag}`),
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
