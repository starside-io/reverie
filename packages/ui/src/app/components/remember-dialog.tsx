import { useState } from "react";

import { NativeSelect, ShelfSelect } from "@/app/components/fields";
import { Failure } from "@/app/components/states";
import { slugOf, today } from "@/lib/format";
import { navigate, memoryHref } from "@/lib/router";
import { useWrite } from "@/lib/use-rpc";
import { KINDS, type MemoryKind, type RememberResult, type SectionEntry } from "@/types";
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
import { Input } from "@/ui/input";
import { Label } from "@/ui/label";
import { Textarea } from "@/ui/textarea";

/** Names typed as "Jane Doe, John Doe". */
export function namesOf(raw: string): string[] {
  return raw
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

/** Tags typed as "#christmas hosting, travel". */
export function tagsOf(raw: string): string[] {
  return [...new Set(raw.split(/[\s,]+/).map(slugOf).filter((slug) => slug.length > 0))];
}

/**
 * memory.remember, the direct door: what the owner types is stored at once,
 * trust stated. With no shelf it waits on Returns. A procedure is not offered:
 * the tool refuses one, and only memory.promote_procedure makes one.
 */
export function RememberDialog({
  open,
  onOpenChange,
  sections,
  shelf,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sections: readonly SectionEntry[];
  shelf: string | null;
}) {
  const write = useWrite<RememberResult>("memory.remember");
  const [body, setBody] = useState("");
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<MemoryKind>("fact");
  const [where, setWhere] = useState(shelf ?? "");
  const [day, setDay] = useState(today());
  const [tags, setTags] = useState("");
  const [people, setPeople] = useState("");

  const submit = async () => {
    const result = await write.run({
      body,
      kind,
      occurredOn: day,
      ...(title.trim() ? { title: title.trim() } : {}),
      ...(where ? { shelf: where } : {}),
      tags: tagsOf(tags),
      attendees: namesOf(people),
    });
    if (result) {
      onOpenChange(false);
      navigate(memoryHref(result.memory.call));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Remember something</DialogTitle>
          <DialogDescription>
            Stored at once, in your words, with trust stated. Leave the shelf empty and it waits on Returns at the
            front desk.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="remember-body">What to keep</Label>
            <Textarea id="remember-body" value={body} onChange={(event) => setBody(event.target.value)} rows={4} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="remember-title">Title (optional)</Label>
            <Input id="remember-title" value={title} onChange={(event) => setTitle(event.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="remember-kind">Kind</Label>
              <NativeSelect
                id="remember-kind"
                value={kind}
                onChange={(event) => setKind(event.target.value as MemoryKind)}
              >
                {KINDS.filter((value) => value !== "procedure").map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="remember-day">When it happened</Label>
              <Input id="remember-day" type="date" value={day} onChange={(event) => setDay(event.target.value)} />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="remember-shelf">Shelf</Label>
            <ShelfSelect
              id="remember-shelf"
              sections={sections}
              value={where}
              onChange={(event) => setWhere(event.target.value)}
              emptyLabel="None yet: wait on Returns (DSK/RET)"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="remember-tags">Tags</Label>
            <Input
              id="remember-tags"
              placeholder="christmas, hosting"
              value={tags}
              onChange={(event) => setTags(event.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="remember-people">Who was there</Label>
            <Input
              id="remember-people"
              placeholder="Jane Doe, John Doe"
              value={people}
              onChange={(event) => setPeople(event.target.value)}
            />
            <p className="text-muted-foreground text-xs">Kept as names. Nobody is matched to a person here.</p>
          </div>
          {write.error ? <Failure error={write.error} /> : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={write.pending || body.trim().length === 0}>
              {write.pending ? "Saving..." : "Remember"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
