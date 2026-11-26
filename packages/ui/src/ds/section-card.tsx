import type * as React from "react";
import { ChevronRight } from "lucide-react";

import { cn } from "@/lib/cn";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/ui/card";

export type SectionCardProps = {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Sits top right of the header: a button or a count. */
  action?: React.ReactNode;
  /** Sits below the content: confirm and cancel buttons, result text. */
  footer?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  contentClassName?: string;
  /**
   * Folds the body away behind the header. Built on `details` so the card stays
   * a server component, which is why the action sits outside the summary: a
   * click on a button inside a summary would toggle the card as well.
   */
  collapsible?: boolean;
  /** Only read on the first render, the browser owns the state after that. */
  defaultOpen?: boolean;
};

/** A card with a titled header, used for settings panels and detail sections. */
export function SectionCard({
  title,
  description,
  action,
  footer,
  children,
  className,
  contentClassName,
  collapsible = false,
  defaultOpen = true,
}: SectionCardProps) {
  if (collapsible) {
    return (
      <Card className={cn("relative", className)}>
        <details
          open={defaultOpen}
          className="group/collapse flex flex-col gap-(--card-spacing)"
        >
          <summary
            className={cn(
              "flex cursor-pointer list-none items-start gap-2 px-(--card-spacing) [&::-webkit-details-marker]:hidden",
              // Keeps the title clear of the action, which is absolutely
              // positioned over the same row.
              action && "pr-28",
            )}
          >
            <ChevronRight
              aria-hidden="true"
              className="mt-1 size-4 shrink-0 text-muted-foreground transition-transform group-open/collapse:rotate-90"
            />
            <div className="grid min-w-0 gap-1">
              <CardTitle>{title}</CardTitle>
              {description ? (
                <CardDescription>{description}</CardDescription>
              ) : null}
            </div>
          </summary>
          <CardContent className={contentClassName}>{children}</CardContent>
          {footer ? <CardFooter>{footer}</CardFooter> : null}
        </details>
        {action ? (
          <div className="absolute top-(--card-spacing) right-(--card-spacing)">
            {action}
          </div>
        ) : null}
      </Card>
    );
  }

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
        {action ? <CardAction>{action}</CardAction> : null}
      </CardHeader>
      <CardContent className={contentClassName}>{children}</CardContent>
      {footer ? <CardFooter>{footer}</CardFooter> : null}
    </Card>
  );
}
