import type { ReactNode } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";

import type { RpcError } from "@/client";
import { cn } from "@/lib/cn";
import { Alert, AlertDescription, AlertTitle } from "@/ui/alert";
import { Skeleton } from "@/ui/skeleton";

/** While a read is in flight and there is nothing on screen yet. */
export function Loading({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={cn("space-y-2", className)} aria-busy="true" aria-live="polite">
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton key={index} className="h-10 w-full" />
      ))}
    </div>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <span className="text-muted-foreground inline-flex items-center gap-2 text-sm">
      <Loader2 className="size-3.5 animate-spin" aria-hidden />
      {label}
    </span>
  );
}

/**
 * A refusal, shown as what it is. An invalid_input carries the field messages
 * the host sent, because "invalid" on its own is not something a person can
 * act on.
 */
export function Failure({ error, children }: { error: RpcError; children?: ReactNode }) {
  const issues = error.isInput ? error.issues : [];

  return (
    <Alert variant="destructive">
      <AlertTriangle className="size-4" />
      <AlertTitle>{titleFor(error.code)}</AlertTitle>
      <AlertDescription>
        <p>{error.message}</p>
        {issues.length > 0 ? (
          <ul className="list-disc space-y-0.5 pl-4">
            {issues.map((issue) => (
              <li key={`${issue.path}:${issue.message}`}>
                <span className="font-medium">{issue.path || "input"}</span>: {issue.message}
              </li>
            ))}
          </ul>
        ) : null}
        {children}
      </AlertDescription>
    </Alert>
  );
}

function titleFor(code: string): string {
  switch (code) {
    case "unreachable":
      return "The host is not answering";
    case "invalid_input":
      return "That input was refused";
    case "not_found":
      return "Not here";
    case "refused":
      return "Refused";
    default:
      return "Something went wrong";
  }
}

/** A figure that is not there yet, said as thin rather than filled in. */
export function Thin({ count, threshold }: { count: number; threshold?: number }) {
  return (
    <span className="text-muted-foreground text-sm">
      not enough yet
      <span className="text-muted-foreground/70">
        {" "}
        ({count}
        {threshold === undefined ? "" : ` of ${threshold}`})
      </span>
    </span>
  );
}
