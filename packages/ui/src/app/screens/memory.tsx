import { useState, type ReactNode } from "react";
import { Archive, ArrowRightLeft, Pencil, Trash2, X } from "lucide-react";

import { ConfirmDialog } from "@/app/components/confirm";
import { CallNumber, ShelfSelect } from "@/app/components/fields";
import { tagsOf } from "@/app/components/remember-dialog";
import { Failure, Loading } from "@/app/components/states";
import { SectionCard } from "@/ds/section-card";
import { longDay, when } from "@/lib/format";
import { memoryHref, navigate, shelfHref, useLinkHandler } from "@/lib/router";
import { useRpc, useWrite } from "@/lib/use-rpc";
import type {
  ForgetResult,
  GetResult,
  HistoryResult,
  MemoryView,
  RelatedResult,
  RenderedRef,
  SectionEntry,
  ShelveMoveResult,
  ShelvesResult,
  SourcesResult,
} from "@/types";
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

/**
 * One memory (docs/SPEC.md section 20): call number, body, tags, attendees,
 * the linked occasion, sources with quotes, version history and related
 * entries. memory.get, memory.sources, memory.history and memory.related read
 * it; edit is memory.update (a new version, same number), shelve is
 * memory.shelve (a new number, the old one kept as an alias), tags are
 * memory.set_tags, retire is memory.retire and forget is memory.forget.
 */

export function Memory({ call }: { call: string }) {
  const got = useRpc<GetResult>("memory.get", { call });

  if (got.error) {
    // A forgotten number answers not_found, and the host's message says it
    // was forgotten and is never reissued.
    return (
      <div className="space-y-3">
        <h1 className="font-heading text-xl font-semibold">
          <CallNumber call={call} className="text-base" />
        </h1>
        <Failure error={got.error} />
      </div>
    );
  }
  if (!got.data) return <Loading lines={8} />;

  return <MemoryPage asked={call} moved={got.data.moved} memory={got.data.memory} />;
}

function MemoryPage({ asked, moved, memory }: { asked: string; moved: boolean; memory: MemoryView }) {
  const onLink = useLinkHandler();
  const shelves = useRpc<ShelvesResult>("memory.shelves");
  const [dialog, setDialog] = useState<"edit" | "shelve" | "retire" | "forget" | null>(null);
  const close = (open: boolean) => {
    if (!open) setDialog(null);
  };
  const editable = memory.state === "active";

  return (
    <article className="space-y-6">
      <header className="space-y-2">
        <p className="text-muted-foreground text-sm">
          <a href={shelfHref(memory.shelf)} onClick={onLink} className="hover:underline">
            {memory.shelf}
          </a>{" "}
          · {longDay(memory.occurredOn)}
        </p>
        <h1 className="font-heading text-2xl font-semibold tracking-tight">{memory.title}</h1>
        <p>
          <CallNumber call={memory.call} className="text-sm" />
        </p>
        {moved ? (
          <p className="text-muted-foreground text-sm">
            You asked for <CallNumber call={asked} />, an old number of this memory. It lives at{" "}
            <CallNumber call={memory.call} /> now.
          </p>
        ) : null}
        <p className="text-muted-foreground text-sm">
          {memory.kind}, trust {memory.trust}, importance {memory.importance} of 5, {memory.state}
          {memory.pinned ? ", pinned" : ""}. Last confirmed {when(memory.lastConfirmedAt)}.
        </p>
        {memory.supersededBy ? (
          <p className="text-sm">
            Superseded by{" "}
            <a href={memoryHref(memory.supersededBy)} onClick={onLink} className="text-thread hover:underline">
              <CallNumber call={memory.supersededBy} />
            </a>
            .
          </p>
        ) : null}
      </header>

      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={!editable} onClick={() => setDialog("edit")}>
          <Pencil aria-hidden /> Edit
        </Button>
        <Button variant="outline" onClick={() => setDialog("shelve")}>
          <ArrowRightLeft aria-hidden /> Shelve
        </Button>
        <Button variant="outline" disabled={!editable} onClick={() => setDialog("retire")}>
          <Archive aria-hidden /> Retire
        </Button>
        <Button variant="destructive" onClick={() => setDialog("forget")}>
          <Trash2 aria-hidden /> Forget
        </Button>
      </div>

      <div className="bg-card rounded-lg border p-4 whitespace-pre-wrap">{memory.body}</div>
      {memory.why ? <Detail label="Why">{memory.why}</Detail> : null}
      {memory.howToApply ? <Detail label="How to apply">{memory.howToApply}</Detail> : null}

      <TagEditor memory={memory} />

      <div className="grid gap-6 lg:grid-cols-2">
        <SectionCard title="People and occasion">
          <People memory={memory} />
        </SectionCard>
        <SourcesCard call={memory.call} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <HistoryCard call={memory.call} />
        <RelatedCard call={memory.call} />
      </div>

      {memory.aliases.length > 0 ? (
        <p className="text-muted-foreground text-sm">
          Also known as {memory.aliases.join(", ")}: old numbers that still resolve here.
        </p>
      ) : null}

      {dialog === "edit" ? <EditDialog memory={memory} onOpenChange={close} /> : null}
      {dialog === "shelve" ? (
        <ShelveDialog memory={memory} sections={shelves.data?.sections ?? []} onOpenChange={close} />
      ) : null}
      {dialog === "retire" ? <RetireDialog memory={memory} onOpenChange={close} /> : null}
      {dialog === "forget" ? <ForgetDialog memory={memory} onOpenChange={close} /> : null}
    </article>
  );
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <h2 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">{label}</h2>
      <p className="mt-1 whitespace-pre-wrap">{children}</p>
    </div>
  );
}

/** Tags: each one detaches with its own button; new ones attach from the field. */
function TagEditor({ memory }: { memory: MemoryView }) {
  const write = useWrite("memory.set_tags");
  const [draft, setDraft] = useState("");
  const onLink = useLinkHandler();

  const attach = async () => {
    const slugs = tagsOf(draft);
    if (slugs.length === 0) return;
    const done = await write.run({ action: "memory", call: memory.call, attach: slugs });
    if (done) setDraft("");
  };

  return (
    <section aria-label="Tags" className="space-y-2">
      <h2 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">Tags</h2>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {memory.tags.length === 0 ? <li className="text-muted-foreground">No tags.</li> : null}
        {memory.tags.map((tag) => (
          <li key={tag} className="flex items-center gap-1">
            <a href="/tags" onClick={onLink} className="hover:underline">
              #{tag}
            </a>
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground"
              aria-label={`Remove #${tag}`}
              disabled={write.pending}
              onClick={() => void write.run({ action: "memory", call: memory.call, detach: [tag] })}
            >
              <X className="size-3.5" aria-hidden />
            </button>
          </li>
        ))}
      </ul>
      <form
        className="flex max-w-md gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void attach();
        }}
      >
        <Input
          aria-label="Add tags"
          placeholder="Add tags: travel, #christmas"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <Button type="submit" variant="outline" disabled={write.pending || tagsOf(draft).length === 0}>
          Add
        </Button>
      </form>
      {write.error ? <Failure error={write.error} /> : null}
    </section>
  );
}

function refLine(ref: RenderedRef): string {
  if (ref.status === "unresolved") return `${ref.label} (a name, not linked to a person)`;
  if (ref.status === "unavailable") return `${ref.label} (the people module is not answering for it)`;
  return ref.label;
}

function People({ memory }: { memory: MemoryView }) {
  return (
    <dl className="grid gap-3 text-sm">
      <div>
        <dt className="text-muted-foreground">Attendees</dt>
        <dd>
          {memory.attendees.length === 0 ? (
            <span className="text-muted-foreground">Nobody recorded.</span>
          ) : (
            <ul>
              {memory.attendees.map((ref) => (
                <li key={`${ref.uri ?? ""}|${ref.label}`}>{refLine(ref)}</li>
              ))}
            </ul>
          )}
        </dd>
      </div>
      {memory.mentions.length > 0 ? (
        <div>
          <dt className="text-muted-foreground">Mentions</dt>
          <dd>
            <ul>
              {memory.mentions.map((ref) => (
                <li key={`${ref.uri ?? ""}|${ref.label}`}>{refLine(ref)}</li>
              ))}
            </ul>
          </dd>
        </div>
      ) : null}
      <div>
        <dt className="text-muted-foreground">Occasion</dt>
        <dd>
          {memory.occasion ? (
            <>
              {refLine(memory.occasion)}
              {memory.occasion.uri ? (
                <span className="text-muted-foreground block font-mono text-xs">{memory.occasion.uri}</span>
              ) : null}
            </>
          ) : (
            <span className="text-muted-foreground">None linked.</span>
          )}
        </dd>
      </div>
    </dl>
  );
}

function SourcesCard({ call }: { call: string }) {
  const sources = useRpc<SourcesResult>("memory.sources", { call });
  return (
    <SectionCard title="Sources" description="Where this came from, with the words it cites.">
      {sources.error ? <Failure error={sources.error} /> : null}
      {sources.loading ? <Loading lines={2} /> : null}
      <ul className="space-y-3 text-sm">
        {(sources.data?.sources ?? []).map((source) => (
          <li key={source.sourceId}>
            <p className="font-medium">{source.label}</p>
            <p className="text-muted-foreground text-xs">
              {source.kind}, trust {source.trust}
              {source.occurredAt ? `, ${when(source.occurredAt)}` : ""}
              {source.citedBy > 1 ? `, cited by ${source.citedBy} memories` : ""}
            </p>
            {source.uri ? <p className="text-muted-foreground font-mono text-xs break-all">{source.uri}</p> : null}
            <blockquote className="border-border mt-1 border-l-2 pl-3 italic">{source.quote}</blockquote>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}

function HistoryCard({ call }: { call: string }) {
  const history = useRpc<HistoryResult>("memory.history", { call });
  const versions = history.data?.versions ?? [];
  return (
    <SectionCard title="Version history" description="Every change is a version. Nothing is edited in place.">
      {history.error ? <Failure error={history.error} /> : null}
      {history.loading ? <Loading lines={2} /> : null}
      <ol className="space-y-3 text-sm">
        {[...versions].reverse().map((version) => (
          <li key={version.id}>
            <p>
              <span className="font-medium">{version.operation}</span>{" "}
              <span className="text-muted-foreground">
                by {version.actor}, {when(version.at)}
              </span>
            </p>
            {version.redacted || !version.content ? (
              <p className="text-muted-foreground">Content redacted.</p>
            ) : (
              <p className="text-muted-foreground">
                <CallNumber call={version.content.callNumber} />: {version.content.title}
                {version.content.tags.length > 0 ? `, ${version.content.tags.map((tag) => `#${tag}`).join(" ")}` : ""}
              </p>
            )}
          </li>
        ))}
      </ol>
    </SectionCard>
  );
}

function RelatedCard({ call }: { call: string }) {
  const related = useRpc<RelatedResult>("memory.related", { call });
  const onLink = useLinkHandler();
  const items = related.data?.items ?? [];
  return (
    <SectionCard title="Related" description="Others that share its tags, people or occasion.">
      {related.error ? <Failure error={related.error} /> : null}
      {related.loading ? <Loading lines={2} /> : null}
      {related.data && items.length === 0 ? <p className="text-muted-foreground text-sm">Nothing shares anything with it yet.</p> : null}
      <ul className="space-y-2 text-sm">
        {items.map((item) => (
          <li key={item.id}>
            <a href={memoryHref(item.call)} onClick={onLink} className="hover:underline">
              <CallNumber call={item.call} className="text-muted-foreground mr-2" />
              {item.title}
            </a>
            <span className="text-muted-foreground block text-xs">{item.reason}</span>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}

/* ------------------------------------------------------------- dialogs */

function EditDialog({ memory, onOpenChange }: { memory: MemoryView; onOpenChange: (open: boolean) => void }) {
  const write = useWrite("memory.update");
  const [title, setTitle] = useState(memory.title);
  const [body, setBody] = useState(memory.body);
  const [importance, setImportance] = useState(memory.importance);

  const save = async () => {
    const done = await write.run({ call: memory.call, title, body, importance });
    if (done) onOpenChange(false);
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit {memory.call}</DialogTitle>
          <DialogDescription>
            Saving writes a new version with the same call number. The current wording stays readable in the history.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="edit-title">Title</Label>
            <Input id="edit-title" value={title} onChange={(event) => setTitle(event.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="edit-body">Body</Label>
            <Textarea id="edit-body" rows={6} value={body} onChange={(event) => setBody(event.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="edit-importance">Importance, 1 to 5</Label>
            <Input
              id="edit-importance"
              type="number"
              min={1}
              max={5}
              value={importance}
              onChange={(event) => setImportance(Number(event.target.value))}
            />
          </div>
          {write.error ? <Failure error={write.error} /> : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={write.pending}>
              {write.pending ? "Saving..." : "Save a new version"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ShelveDialog({
  memory,
  sections,
  onOpenChange,
}: {
  memory: MemoryView;
  sections: readonly SectionEntry[];
  onOpenChange: (open: boolean) => void;
}) {
  const write = useWrite<ShelveMoveResult>("memory.shelve");
  const [shelf, setShelf] = useState(memory.shelf);
  const [day, setDay] = useState(memory.occurredOn);
  const unchanged = shelf === memory.shelf && day === memory.occurredOn;

  const move = async () => {
    const result = await write.run({
      action: "move",
      call: memory.call,
      ...(shelf !== memory.shelf ? { shelf } : {}),
      ...(day !== memory.occurredOn ? { occurredOn: day } : {}),
    });
    if (result) {
      onOpenChange(false);
      navigate(memoryHref(result.to));
    }
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Shelve {memory.call}</DialogTitle>
          <DialogDescription>
            Moving it issues a new call number. {memory.call} is kept as an alias, so anything that quoted it still
            finds it.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void move();
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="shelve-shelf">Shelf</Label>
            <ShelfSelect
              id="shelve-shelf"
              sections={sections}
              value={shelf}
              onChange={(event) => setShelf(event.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="shelve-day">When it happened</Label>
            <Input id="shelve-day" type="date" value={day} onChange={(event) => setDay(event.target.value)} />
          </div>
          {write.error ? <Failure error={write.error} /> : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={write.pending || unchanged}>
              {write.pending ? "Moving..." : `Move to ${shelf}`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RetireDialog({ memory, onOpenChange }: { memory: MemoryView; onOpenChange: (open: boolean) => void }) {
  const write = useWrite("memory.retire");
  return (
    <ConfirmDialog
      open
      onOpenChange={onOpenChange}
      title={`Retire ${memory.call}?`}
      action={`Retire ${memory.call}`}
      pending={write.pending}
      error={write.error}
      onConfirm={async () => {
        if (await write.run({ call: memory.call })) onOpenChange(false);
      }}
    >
      <p>
        "{memory.title}" moves to the stacks: it stops being recalled, and stays browsable with its number and history.
        Nothing is deleted.
      </p>
    </ConfirmDialog>
  );
}

function ForgetDialog({ memory, onOpenChange }: { memory: MemoryView; onOpenChange: (open: boolean) => void }) {
  const write = useWrite<ForgetResult>("memory.forget");
  const numbers = [memory.call, ...memory.aliases];
  return (
    <ConfirmDialog
      open
      onOpenChange={onOpenChange}
      title={`Forget ${memory.call}?`}
      action={`Forget ${memory.call}`}
      destructive
      pending={write.pending}
      error={write.error}
      onConfirm={async () => {
        const result = await write.run({ call: memory.call, confirmedByUser: true });
        if (result) {
          onOpenChange(false);
          navigate(shelfHref(memory.shelf));
        }
      }}
    >
      <p>
        This deletes the memory {memory.call}, "{memory.title}": its body, its search entry, and the content of
        every past version. Sources and tags that no other memory uses go with it.
      </p>
      {numbers.length > 1 ? (
        <p>Its old numbers {memory.aliases.join(", ")} stop resolving too.</p>
      ) : null}
      <p className="text-foreground font-medium">
        It will not come back. {memory.call} is never issued again.
      </p>
    </ConfirmDialog>
  );
}
