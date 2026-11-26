import { useState } from "react";

import { CallNumber } from "@/app/components/fields";
import { PageHeader } from "@/app/components/page-header";
import { tagsOf } from "@/app/components/remember-dialog";
import { Failure, Spinner } from "@/app/components/states";
import { RpcError, rpc } from "@/client";
import { figure } from "@/lib/format";
import { memoryHref, useLinkHandler } from "@/lib/router";
import type { ExplainResult, RecallResult } from "@/types";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Label } from "@/ui/label";

/**
 * The recall inspector (docs/SPEC.md section 20, section 14): type a query,
 * see exactly what a model would be handed, and the four numbers behind each
 * item.
 *
 * memory.recall returns the framed result and one score per item. The
 * numbers behind the score come from memory.explain, asked once per item with
 * the recall's id: recency, the importance factor and the trust weight as
 * they stand, and the unrounded score the recall logged. Relevance is the one
 * number neither tool returns, because it comes from the query and the query
 * is never logged; it is worked back here from the scoring formula of section
 * 14:
 *
 *   score = relevance * (0.5 + 0.5 * recency) * importanceFactor * trustWeight
 */

export interface Breakdown {
  call: string;
  score: number;
  relevance: number | null;
  recency: number | null;
  halfLifeDays: number | null;
  importance: number | null;
  importanceFactor: number | null;
  trust: string | null;
  trustWeight: number | null;
}

/** Relevance, worked back from the logged score and the three factors that do not depend on the query. */
export function relevanceOf(score: number, recency: number, importanceFactor: number, trustWeight: number): number | null {
  const rest = (0.5 + 0.5 * recency) * importanceFactor * trustWeight;
  return rest > 0 ? score / rest : null;
}

/** The text an MCP client receives for this result: the JSON the stdio server writes. */
export function asHandedOver(result: RecallResult): string {
  return JSON.stringify(result, null, 2);
}

export function RecallInspector() {
  const onLink = useLinkHandler();
  const [query, setQuery] = useState("");
  const [shelf, setShelf] = useState("");
  const [tags, setTags] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<RpcError | undefined>(undefined);
  const [result, setResult] = useState<RecallResult | null>(null);
  const [numbers, setNumbers] = useState<Breakdown[]>([]);

  const run = async () => {
    setBusy(true);
    setError(undefined);
    setResult(null);
    setNumbers([]);
    try {
      const recalled = await rpc<RecallResult>("memory.recall", {
        query,
        ...(shelf.trim() ? { shelf: shelf.trim().toUpperCase() } : {}),
        ...(tagsOf(tags).length > 0 ? { tags: tagsOf(tags) } : {}),
      });
      setResult(recalled);
      if (recalled.sufficient) {
        const recallId = recalled.recallId;
        const explained = await Promise.all(
          recalled.items.map((item) =>
            rpc<ExplainResult>("memory.explain", { call: item.call, ...(recallId ? { recallId } : {}), limit: 1 }),
          ),
        );
        setNumbers(
          recalled.items.map((item, index) => {
            const answer = explained[index];
            const weights = answer?.weights ?? null;
            // The logged score is unrounded; the framed one carries two
            // decimals. Without a log row (incognito), the framed one is all
            // there is.
            const logged = recallId ? answer?.recalls.find((entry) => entry.recallId === recallId)?.match?.score : undefined;
            const score = logged ?? item.score;
            return {
              call: item.call,
              score,
              relevance: weights
                ? relevanceOf(score, weights.recency, weights.importanceFactor, weights.trustWeight)
                : null,
              recency: weights?.recency ?? null,
              halfLifeDays: weights?.halfLifeDays ?? null,
              importance: weights?.importance ?? null,
              importanceFactor: weights?.importanceFactor ?? null,
              trust: weights?.trust ?? null,
              trustWeight: weights?.trustWeight ?? null,
            };
          }),
        );
      }
    } catch (caught) {
      setError(caught instanceof RpcError ? caught : new RpcError("memory.recall", "failed", String(caught)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Recall inspector"
        description="What a model would be handed for a query, and why. This runs a real recall: it writes one recall log row (ids and scores, never your query) and counts toward each item's recall count, as a model's recall would."
      />

      <form
        className="bg-card grid gap-3 rounded-lg border p-4 md:grid-cols-[minmax(0,1fr)_10rem_12rem_auto] md:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          if (query.trim()) void run();
        }}
      >
        <div className="grid gap-1.5">
          <Label htmlFor="recall-query">Query</Label>
          <Input
            id="recall-query"
            placeholder="What did we do for Christmas?"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="recall-shelf">Shelf or prefix</Label>
          <Input id="recall-shelf" placeholder="LIF/GTH" value={shelf} onChange={(event) => setShelf(event.target.value)} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="recall-tags">Tags</Label>
          <Input id="recall-tags" placeholder="christmas" value={tags} onChange={(event) => setTags(event.target.value)} />
        </div>
        <Button type="submit" disabled={busy || query.trim().length === 0}>
          Recall
        </Button>
      </form>

      {busy ? <Spinner label="Recalling" /> : null}
      {error ? <Failure error={error} /> : null}

      {result && !result.sufficient ? (
        <section aria-label="Abstained" className="rounded-lg border p-4">
          <h2 className="font-heading text-lg font-semibold">Recall abstained</h2>
          <p className="text-muted-foreground mt-1 text-sm">
            Nothing cleared the recall floor, so nothing is returned and nothing is padded in from below it. A model
            would be handed exactly this, and should say it does not know:
          </p>
          <pre className="bg-muted mt-3 overflow-x-auto rounded-md p-3 font-mono text-xs">{asHandedOver(result)}</pre>
        </section>
      ) : null}

      {result && result.sufficient ? (
        <>
          <section aria-label="The four numbers" className="space-y-2">
            <h2 className="font-heading text-lg font-semibold">The four numbers behind each item</h2>
            <p className="text-muted-foreground text-sm">
              Score is relevance times (0.5 + 0.5 times recency) times the importance factor times the trust weight.
              Relevance is worked back from the logged score; the other three are what memory.explain reports.
            </p>
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full text-sm">
                <thead className="bg-muted/60 text-muted-foreground text-left text-xs">
                  <tr>
                    <th className="px-3 py-2 font-medium">Rank</th>
                    <th className="px-3 py-2 font-medium">Call number</th>
                    <th className="px-3 py-2 font-medium">Score</th>
                    <th className="px-3 py-2 font-medium">Relevance</th>
                    <th className="px-3 py-2 font-medium">Recency</th>
                    <th className="px-3 py-2 font-medium">Importance</th>
                    <th className="px-3 py-2 font-medium">Trust weight</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {result.items.map((item, index) => {
                    const row = numbers[index];
                    return (
                      <tr key={item.call}>
                        <td className="px-3 py-2 tabular-nums">{index + 1}</td>
                        <td className="px-3 py-2">
                          <a href={memoryHref(item.call)} onClick={onLink} className="hover:underline">
                            <CallNumber call={item.call} />
                          </a>
                        </td>
                        <td className="px-3 py-2 tabular-nums">{figure(row?.score ?? item.score)}</td>
                        <td className="px-3 py-2 tabular-nums">{figure(row?.relevance)}</td>
                        <td className="px-3 py-2 tabular-nums">
                          {figure(row?.recency)}
                          <span className="text-muted-foreground block text-xs">
                            {row?.halfLifeDays ? `half life ${row.halfLifeDays} days` : row ? "no half life" : ""}
                          </span>
                        </td>
                        <td className="px-3 py-2 tabular-nums">
                          {figure(row?.importanceFactor)}
                          <span className="text-muted-foreground block text-xs">
                            {row?.importance ? `${row.importance} of 5` : ""}
                          </span>
                        </td>
                        <td className="px-3 py-2 tabular-nums">
                          {figure(row?.trustWeight)}
                          <span className="text-muted-foreground block text-xs">{row?.trust ?? item.trust}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="text-muted-foreground text-xs">
              {result.retrieval.vectors
                ? "Found by full text search and vectors, fused by rank."
                : `Found by full text search alone${result.retrieval.ftsOnlyReason ? ` (${result.retrieval.ftsOnlyReason.replaceAll("_", " ")})` : ""}.`}
              {result.recallId ? ` Recall log row ${result.recallId}.` : " Incognito is on, so no recall log row was written."}
            </p>
          </section>

          <section aria-label="Handed to a model" className="space-y-2">
            <h2 className="font-heading text-lg font-semibold">Handed to a model</h2>
            <p className="text-muted-foreground text-sm">The result exactly as the MCP server writes it.</p>
            <pre className="bg-muted overflow-x-auto rounded-md p-3 font-mono text-xs">{asHandedOver(result)}</pre>
          </section>
        </>
      ) : null}
    </div>
  );
}
