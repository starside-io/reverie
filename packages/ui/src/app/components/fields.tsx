import type { ComponentProps } from "react";

import { cn } from "@/lib/cn";
import type { SectionEntry } from "@/types";

/**
 * Native selects, styled like the inputs. A shelf list is short and a native
 * control is the one that works with every keyboard and screen reader.
 */

const SELECT_CLASSES =
  "border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 h-8 w-full rounded-lg border px-2 text-sm outline-none focus-visible:ring-3 dark:bg-input/30";

export function NativeSelect({ className, ...props }: ComponentProps<"select">) {
  return <select className={cn(SELECT_CLASSES, className)} {...props} />;
}

/** Every shelf, grouped by section, valued by its path: "LIF/GTH". */
export function ShelfSelect({
  sections,
  emptyLabel,
  ...props
}: ComponentProps<"select"> & {
  sections: readonly SectionEntry[];
  /** A first choice with no value, such as "Returns, shelve later". */
  emptyLabel?: string;
}) {
  return (
    <NativeSelect {...props}>
      {emptyLabel ? <option value="">{emptyLabel}</option> : null}
      {sections.map((section) => (
        <optgroup key={section.code} label={`${section.code} ${section.name}`}>
          {section.shelves.map((shelf) => (
            <option key={shelf.path} value={shelf.path}>
              {shelf.path} {shelf.name}
            </option>
          ))}
        </optgroup>
      ))}
    </NativeSelect>
  );
}

/** A call number, set in the monospace face so its parts line up down a list. */
export function CallNumber({ call, className }: { call: string; className?: string }) {
  return <span className={cn("font-mono text-xs tabular-nums", className)}>{call}</span>;
}
