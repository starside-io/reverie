import type * as React from "react";

import { cn } from "@/lib/cn";

export type EmptyStateProps = {
  /** A lucide icon element, for example <Share2 className="size-6" />. */
  icon?: React.ReactNode;
  title: string;
  description?: string;
  /** A link or button offering the obvious next step. */
  action?: React.ReactNode;
  /** sm fits inside narrow cards and side columns. */
  size?: "md" | "sm";
  className?: string;
};

/** The dashed border placeholder shown wherever a list has nothing in it. */
export function EmptyState({
  icon,
  title,
  description,
  action,
  size = "md",
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-2 border border-dashed text-center",
        size === "sm" ? "rounded-lg p-4" : "rounded-xl p-10",
        className,
      )}
    >
      {icon ? (
        <span className="text-muted-foreground" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <p className="font-medium">{title}</p>
      {description ? (
        <p className="max-w-sm text-sm text-muted-foreground">{description}</p>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
