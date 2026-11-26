import { useState } from "react";

import { CallNumber, NativeSelect } from "@/app/components/fields";
import { PageHeader } from "@/app/components/page-header";
import { Failure, Loading } from "@/app/components/states";
import { RpcError, host, rpc } from "@/client";
import { EmptyState } from "@/ds/empty-state";
import { verbOf, when } from "@/lib/format";
import { memoryHref, useLinkHandler } from "@/lib/router";
import { invalidate, useRpc } from "@/lib/use-rpc";
import type { ReviewItem, ReviewResult, ReviewStep } from "@/types";
import { Button } from "@/ui/button";

/**
 * The review queue (docs/SPEC.md section 20): proposals grouped by the
 * session or the event they were drafted from, each with its verb, its
 * proposed shelf and its quote. memory.review lists them.
 *
 * Confirm and reject go through the mini-host's decision route,
 * POST /host/review/:id/:decision, which runs memory.decide with
 * confirmedByUser set: the owner clicking is the yes. Confirming runs the
 * tool the proposal names; a refused write leaves it pending and says why.
 * When a proposal carries parts of its own (an occasion, notes about a
 * guest), each part has its own choice, and the decision goes to
 * memory.decide over /rpc with those choices, since the host route takes
 * none.
 */

type Payload = Record<string, unknown> & {
  draft?: {
    quote?: string;
    source?: { label?: string; kind?: string };
    newTags?: string[];
    questions?: string[];
    job?: string;
  };
};

type Outcome = { kind: "confirmed"; committed: string | null } | { kind: "rejected" } | { kind: "refused"; message: string };

/** A decision made on this screen, kept in view after its proposal leaves the waiting list. */
interface Decided {
  id: string;
  title: string;
  outcome: Exclude<Outcome, { kind: "refused" }>;
}

function payloadOf(item: ReviewItem): Payload {
  return item.payload && typeof item.payload === "object" ? (item.payload as Payload) : {};
}

/** The shelf a proposal would land on: its own for an add, the target's for a change. */
function proposedShelf(item: ReviewItem): string | null {
  const payload = payloadOf(item);
  if (typeof payload["shelf"] === "string") return payload["shelf"];
  const target = typeof payload["call"] === "string" ? payload["call"] : item.call;
  if (typeof target === "string") return target.split("/").slice(0, 2).join("/");
  if (item.tool === "memory.remember") return "DSK/RET (Returns)";
  return null;
}

interface Group {
  id: string;
  title: string;
  detail: string | null;
  items: ReviewItem[];
}

function groupsOf(review: ReviewResult): Group[] {
  const groups = new Map<string, Group>();
  const loose: ReviewItem[] = [];
  for (const item of review.proposals) {
    if (!item.group) {
      loose.push(item);
      continue;
    }
    const known = review.groups.find((entry) => entry.id === item.group?.id);
    const group = groups.get(item.group.id) ?? {
      id: item.group.id,
      title: item.group.title,
      detail: known?.detail ?? item.group.detail ?? null,
      items: [],
    };
    group.items.push(item);
    groups.set(item.group.id, group);
  }
  const out = [...groups.values()];
  if (loose.length > 0) out.push({ id: "none", title: "Not part of a session or event", detail: null, items: loose });
  return out;
}

export function Review() {
  const [state, setState] = useState<"pending" | "confirmed" | "discarded">("pending");
  const review = useRpc<ReviewResult>("memory.review", { state });
  const [decided, setDecided] = useState<Decided[]>([]);
  const onLink = useLinkHandler();

  return (
    <div>
      <PageHeader
        title="Review"
        description="What a model drafted waits here for your yes or no. Nothing below is in the library until you confirm it."
        action={
          <NativeSelect
            aria-label="Which proposals"
            value={state}
            onChange={(event) => setState(event.target.value as typeof state)}
          >
            <option value="pending">Waiting</option>
            <option value="confirmed">Confirmed</option>
            <option value="discarded">Rejected</option>
          </NativeSelect>
        }
      />
      {decided.length > 0 ? (
        <section aria-label="Decided just now" aria-live="polite" className="bg-muted/50 mb-6 rounded-lg border p-3 text-sm">
          <h2 className="mb-1 font-medium">Decided just now</h2>
          <ul className="space-y-1">
            {decided.map((entry) => (
              <li key={entry.id}>
                {entry.outcome.kind === "confirmed" ? "Confirmed" : "Rejected"}: {entry.title}.
                {entry.outcome.kind === "confirmed" && entry.outcome.committed ? (
                  <>
                    {" "}
                    Shelved as{" "}
                    <a
                      href={memoryHref(entry.outcome.committed)}
                      onClick={onLink}
                      className="text-thread hover:underline"
                    >
                      <CallNumber call={entry.outcome.committed} />
                    </a>
                    .
                  </>
                ) : null}
                {entry.outcome.kind === "rejected" ? " Nothing was written." : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {review.error ? <Failure error={review.error} /> : null}
      {review.loading ? <Loading lines={4} /> : null}
      {review.data && review.data.proposals.length === 0 ? (
        <EmptyState
          title={state === "pending" ? "Nothing is waiting" : "Nothing here"}
          description={
            state === "pending" ? "Proposals appear here when an assistant drafts memories from a session." : undefined
          }
        />
      ) : null}
      <div className="space-y-8">
        {review.data
          ? groupsOf(review.data).map((group) => (
              <section key={group.id} aria-label={group.title} className="space-y-3">
                <header>
                  <h2 className="font-heading text-lg font-semibold">{group.title}</h2>
                  {group.detail ? <p className="text-muted-foreground text-sm">{group.detail}</p> : null}
                </header>
                <ul className="space-y-3">
                  {group.items.map((item) => (
                    <Proposal
                      key={item.id}
                      item={item}
                      onDecided={(entry) => setDecided((current) => [entry, ...current])}
                      parts={(review.data?.groups.find((entry) => entry.id === group.id)?.steps ?? []).filter(
                        (step) => step.proposalId === item.id && step.part !== "memory",
                      )}
                    />
                  ))}
                </ul>
              </section>
            ))
          : null}
      </div>
    </div>
  );
}

function Proposal({
  item,
  parts,
  onDecided,
}: {
  item: ReviewItem;
  parts: ReviewStep[];
  onDecided: (entry: Decided) => void;
}) {
  const onLink = useLinkHandler();
  const payload = payloadOf(item);
  const draft = payload.draft ?? {};
  const shelf = proposedShelf(item);
  const [choices, setChoices] = useState<boolean[]>(() => parts.map(() => true));
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const title = typeof payload["title"] === "string" ? payload["title"] : (item.summary ?? item.tool);

  const setOutcome = (outcome: Outcome) => {
    if (outcome.kind === "refused") setRefusal(outcome.message);
    else onDecided({ id: item.id, title, outcome });
  };

  const decide = async (decision: "confirm" | "reject") => {
    setBusy(true);
    setRefusal(null);
    try {
      if (parts.length === 0) {
        const answer = await host.decide(item.id, decision);
        setOutcome(
          answer.ok
            ? decision === "confirm"
              ? { kind: "confirmed", committed: answer.committed ?? null }
              : { kind: "rejected" }
            : { kind: "refused", message: answer.message ?? "Refused" },
        );
      } else {
        const occasion = parts.findIndex((part) => part.part === "occasion");
        const notes = parts
          .map((part, index) => ({ part, index }))
          .filter((entry) => entry.part.part === "note")
          .map((entry) => (choices[entry.index] ? "confirm" : "reject"));
        const result = await rpc<{ state: string; committed?: { call: string } | null }>("memory.decide", {
          proposalId: item.id,
          decision,
          pending: {
            ...(occasion >= 0 ? { occasion: choices[occasion] ? "confirm" : "reject" } : {}),
            ...(notes.length > 0 ? { notes } : {}),
          },
          confirmedByUser: true,
        });
        setOutcome(
          result.state === "confirmed"
            ? { kind: "confirmed", committed: result.committed?.call ?? null }
            : { kind: "rejected" },
        );
      }
    } catch (error) {
      setOutcome({ kind: "refused", message: error instanceof RpcError ? error.message : String(error) });
    } finally {
      setBusy(false);
      invalidate();
    }
  };

  const facts = [
    typeof payload["kind"] === "string" ? payload["kind"] : null,
    typeof payload["occurredOn"] === "string" ? payload["occurredOn"] : null,
    Array.isArray(payload["tags"]) && payload["tags"].length > 0
      ? (payload["tags"] as string[]).map((tag) => `#${tag}${draft.newTags?.includes(tag) ? " (new tag)" : ""}`).join(" ")
      : null,
    Array.isArray(payload["attendees"]) && payload["attendees"].length > 0
      ? `with ${(payload["attendees"] as unknown[]).map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry))).join(", ")}`
      : null,
  ].filter(Boolean);

  return (
    <li className="bg-card rounded-lg border p-4" aria-label={item.summary ?? item.tool}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-medium">
          {verbOf(item.tool)}
          {shelf ? <span className="text-muted-foreground font-normal"> on {shelf}</span> : null}
        </p>
        <p className="text-muted-foreground text-xs">
          {item.tool}, queued {when(item.createdAt)}
        </p>
      </div>
      {typeof payload["title"] === "string" ? <p className="mt-1">{payload["title"]}</p> : null}
      {item.summary ? <p className="text-muted-foreground mt-1 text-sm">{item.summary}</p> : null}
      {typeof payload["body"] === "string" ? (
        <p className="mt-2 text-sm whitespace-pre-wrap">{payload["body"]}</p>
      ) : null}
      {facts.length > 0 ? <p className="text-muted-foreground mt-1 text-xs">{facts.join(" · ")}</p> : null}
      {draft.quote ? (
        <blockquote className="border-border mt-3 border-l-2 pl-3 text-sm italic">
          {draft.quote}
          {draft.source?.label ? (
            <span className="text-muted-foreground block text-xs not-italic">from {draft.source.label}</span>
          ) : null}
        </blockquote>
      ) : null}
      {draft.questions && draft.questions.length > 0 ? (
        <p className="mt-2 text-sm">Open questions: {draft.questions.join("; ")}</p>
      ) : null}

      {parts.length > 0 && item.state === "pending" ? (
        <fieldset className="mt-3 space-y-1 text-sm">
          <legend className="text-muted-foreground text-xs">Also in this proposal, each decided on its own</legend>
          {parts.map((part, index) => (
            <label key={`${part.part}:${part.noteIndex ?? 0}`} className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-1"
                checked={choices[index] ?? true}
                onChange={(event) =>
                  setChoices((current) => current.map((value, at) => (at === index ? event.target.checked : value)))
                }
              />
              <span>
                {part.summary} <span className="text-muted-foreground text-xs">({part.tool}, run by whoever confirms)</span>
              </span>
            </label>
          ))}
        </fieldset>
      ) : null}

      {item.state === "pending" ? (
        <div className="mt-3 flex gap-2">
          <Button disabled={busy} onClick={() => void decide("confirm")}>
            Confirm
          </Button>
          <Button variant="outline" disabled={busy} onClick={() => void decide("reject")}>
            Reject
          </Button>
        </div>
      ) : null}
      {item.state !== "pending" ? (
        <p className="text-muted-foreground mt-2 text-sm">
          {item.state === "confirmed" ? "Confirmed" : "Rejected"}
          {item.decidedAt ? ` ${when(item.decidedAt)}` : ""}.
          {item.call ? (
            <>
              {" "}
              Now{" "}
              <a href={memoryHref(item.call)} onClick={onLink} className="hover:underline">
                <CallNumber call={item.call} />
              </a>
              .
            </>
          ) : null}
        </p>
      ) : null}
      {refusal ? (
        <p className="text-destructive mt-2 text-sm" role="alert">
          {refusal}
        </p>
      ) : null}
    </li>
  );
}
