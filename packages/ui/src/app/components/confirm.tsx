import { useState, type ReactNode } from "react";

import { Failure } from "@/app/components/states";
import type { RpcError } from "@/client";
import { Button } from "@/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";

/**
 * A confirmation that names exactly what it will do (docs/SPEC.md section
 * 20). The action button repeats the thing it acts on, so the last click is
 * never a bare "OK".
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  children,
  action,
  destructive = false,
  pending = false,
  error,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
  /** The button's words, naming what it acts on: "Forget LIF/GTH/2026-12-24/001". */
  action: string;
  destructive?: boolean;
  pending?: boolean;
  error?: RpcError | undefined;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-2">{children}</div>
          </DialogDescription>
        </DialogHeader>
        {error ? <Failure error={error} /> : null}
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button variant={destructive ? "destructive" : "default"} disabled={pending} onClick={onConfirm}>
            {pending ? "Working..." : action}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Open state for one dialog, in one line at the call site. */
export function useDialog(): { open: boolean; setOpen: (open: boolean) => void; show: () => void } {
  const [open, setOpen] = useState(false);
  return { open, setOpen, show: () => setOpen(true) };
}
