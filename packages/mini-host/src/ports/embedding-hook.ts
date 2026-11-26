import { config as coreConfig, domain, storage, tools as coreTools } from "@reverie/core";
import type { ModelsPort, ModuleConfig, Silo } from "@reverie/core";

import type { Embedder } from "../models/index.js";
import type { HostStore } from "./host-store.js";

/**
 * The re-embed hook (docs/SPEC.md section 17), the host's half of the cache
 * rule: `Embedding` is a function of the body and the model, so a change of
 * embedding model or dim re-embeds every memory before the new value counts
 * as applied.
 *
 * How it tracks progress, and why it survives a restart: before the first
 * vector is written the host records the run in host.db under
 * `embedding.reembed` (the target, where it came from, a progress count).
 * Config keeps naming the old model until the run completes, and while the
 * record is there core's recall runs on FTS alone and says `reembedding`, so
 * results never mix two models. The work list is not stored: each pass asks
 * the silo which memories have no vector of the target yet
 * (domain.embeddings.runReembed), so a run cut off half way resumes exactly
 * where it stopped, whether the next run is `resume()` at the next
 * `reverie serve`, `reverie reindex`, or the same change set again. Only
 * once every memory holds a vector of the target are the old rows deleted,
 * the new value written to config, and the record cleared.
 *
 * A run that cannot complete (the model went away, a text it refused) leaves
 * the record in place with the reason, applies nothing, and throws. Setting
 * the model to null drops every vector and clears the record: recall runs on
 * FTS alone. Setting it back to the old value resumes toward that one.
 */

export class SettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsError";
  }
}

export interface EmbeddingHookOptions {
  silo: Silo;
  store: HostStore;
  readConfig(): ModuleConfig;
  writeConfig(config: ModuleConfig): void;
  /** The embedder for a target, or the reason there is none. */
  embedderFor(model: string, dim: number | null): Embedder | string;
  batchSize?: number;
}

export interface EmbeddingStatus {
  model: string | null;
  dim: number | null;
  /** The run under way, when one is. */
  reembed: coreTools.shared.ReembedState | null;
  /** Memories recall can return with no vector of the applied model and dim. */
  missing: number;
  /** Vectors older than their memory's last edit. */
  stale: number;
  /** Rows of another model or dim, never used. */
  other: number;
}

export interface EmbeddingRunReport {
  /** What ran: a re-embed toward a new value, a fill of the applied one, or nothing. */
  ran: "reembed" | "fill" | "none";
  model: string | null;
  dim: number | null;
  embedded: number;
  failed: number;
  removed: number;
  /** True when every memory recall can return holds a vector of the applied model. */
  complete: boolean;
  reason?: string;
}

/** An embedder over an injected models port: whatever model is named, the port computes it. */
export function injectedEmbedder(models: ModelsPort): (model: string, dim: number | null) => Embedder {
  return (_model, dim) => ({ embed: (texts) => models.embed(texts), defaultDim: dim });
}

export function createEmbeddingHook(options: EmbeddingHookOptions) {
  const { silo, store } = options;
  let running: Promise<unknown> = Promise.resolve();

  /** One run at a time in this process: a resume and a settings change never interleave. */
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const next = running.then(work, work);
    running = next.catch(() => undefined);
    return next;
  }

  const readState = () => {
    const value = store.readValue(coreTools.shared.REEMBED_KEY) as coreTools.shared.ReembedState | null | undefined;
    return value && typeof value === "object" && typeof value.model === "string" ? value : null;
  };
  const writeState = (state: coreTools.shared.ReembedState | null) => store.writeValue(coreTools.shared.REEMBED_KEY, state);

  /**
   * Runs (or resumes) a re-embed toward `target` and, when it completes,
   * writes `apply` with the target's model and dim as the applied config.
   */
  async function reembedTo(
    target: { model: string; dim: number | null },
    from: { model: string | null; dim: number | null },
    apply: (embedding: { model: string; dim: number | null }) => ModuleConfig,
  ): Promise<{ config: ModuleConfig; report: EmbeddingRunReport }> {
    const embedder = options.embedderFor(target.model, target.dim);
    if (typeof embedder === "string") {
      throw new SettingsError(
        `embedding.model "${target.model}" cannot be applied: ${embedder} Recall stays on full text search.`,
      );
    }
    const dim = target.dim ?? embedder.defaultDim;
    const previous = readState();
    const state: coreTools.shared.ReembedState = {
      model: target.model,
      dim,
      from: previous && previous.model === target.model && previous.dim === dim ? previous.from : from,
      startedAt: previous && previous.model === target.model && previous.dim === dim ? previous.startedAt : new Date().toISOString(),
    };
    writeState(state);

    const result = await domain.embeddings.runReembed(silo, (texts) => embedder.embed(texts), { model: target.model, dim }, {
      ...(options.batchSize ? { batchSize: options.batchSize } : {}),
      onProgress: ({ embedded, remaining }) => writeState({ ...state, embedded, remaining }),
    });

    if (!result.complete) {
      const reason = result.failed[0]?.reason ?? "Some memories have no vector yet.";
      writeState({ ...state, embedded: result.embedded, remaining: result.failed.length, lastError: reason });
      throw new SettingsError(
        `Re-embedding with "${target.model}" stopped with ${result.failed.length} memories still to do: ${reason} Nothing was applied; recall runs on full text search alone until it finishes. Run \`reverie reindex\` to resume it, or set embedding.model back to clear it.`,
      );
    }

    const config = apply({ model: target.model, dim: result.dim });
    options.writeConfig(config);
    writeState(null);
    return {
      config,
      report: {
        ran: "reembed",
        model: target.model,
        dim: result.dim,
        embedded: result.embedded,
        failed: 0,
        removed: result.removed,
        complete: true,
      },
    };
  }

  /** settings.set, for every patch: the embedding part through the hook, the rest as is. */
  function set(patch: Partial<ModuleConfig>): Promise<ModuleConfig> {
    return serial(async () => {
      const before = options.readConfig();
      const next = coreConfig.mergeConfig(before, patch);
      const pending = readState();
      const model = next.embedding.model;

      if (model === null) {
        // FTS only: every vector goes, so none outlives the model that made it.
        if (before.embedding.model !== null || pending || (await silo.embedding.count()) > 0) {
          await domain.embeddings.dropAllEmbeddings(silo);
        }
        writeState(null);
        options.writeConfig(next);
        return next;
      }

      const sameModel = model === before.embedding.model;
      const dim = next.embedding.dim ?? (sameModel ? before.embedding.dim : null);
      const unchanged = sameModel && dim === before.embedding.dim;
      if (unchanged && !pending) {
        options.writeConfig(next);
        return next;
      }

      const { config } = await reembedTo({ model, dim }, before.embedding, (embedding) =>
        coreConfig.mergeConfig(next, { embedding }),
      );
      return config;
    });
  }

  /**
   * Finishes what is left: a re-embed a previous process did not complete,
   * else the vectors the applied model is missing (an embed that failed at
   * write, a restore) and the ones left stale. Safe to run any time; with no
   * model configured it does nothing.
   */
  function resume(): Promise<EmbeddingRunReport> {
    return serial(async () => {
      const pending = readState();
      if (pending) {
        const { report } = await reembedTo({ model: pending.model, dim: pending.dim }, pending.from, (embedding) =>
          coreConfig.mergeConfig(options.readConfig(), { embedding }),
        );
        return report;
      }

      const { model, dim } = options.readConfig().embedding;
      if (!model) return { ran: "none", model: null, dim: null, embedded: 0, failed: 0, removed: 0, complete: true };
      const embedder = options.embedderFor(model, dim);
      if (typeof embedder === "string") {
        return { ran: "none", model, dim, embedded: 0, failed: 0, removed: 0, complete: false, reason: embedder };
      }
      const target = { model, dim: dim ?? embedder.defaultDim };
      const embed = (texts: string[]) => embedder.embed(texts);
      const batch = options.batchSize ? { batchSize: options.batchSize } : {};

      // Missing: no row of this model and dim.
      const filled = await domain.embeddings.fillMissingEmbeddings(silo, embed, target, batch);
      // Stale: a row of this model computed before the memory's last edit.
      const stale = await domain.embeddings.memoriesWithStaleEmbedding(silo, model);
      let refreshed = 0;
      if (stale.length > 0) {
        const rows = await silo.memory.findMany({ where: { id: { in: stale } }, select: { id: true, title: true, body: true } });
        const prepared = await domain.embeddings.prepareVectors(
          embed,
          target,
          rows.map((row) => ({ memoryId: row.id, text: domain.embeddings.embeddingText(row) })),
          options.batchSize,
        );
        for (const [memoryId, vector] of prepared) {
          if ((await domain.embeddings.storeVector(silo, memoryId, vector)).status === "written") refreshed += 1;
        }
      }
      const left = await domain.embeddings.memoriesMissingEmbedding(silo, target.model, target.dim);
      // Rows of another model or dim are never used; once nothing is missing they are only weight.
      const removed = left.length === 0 ? await storage.deleteOtherEmbeddings(silo, target) : 0;
      return {
        ran: "fill",
        model,
        dim: target.dim,
        embedded: filled.embedded.length + refreshed,
        failed: left.length,
        removed,
        complete: left.length === 0,
        ...(left.length > 0 ? { reason: filled.failed[0]?.reason ?? "Some memories have no vector yet." } : {}),
      };
    });
  }

  async function status(): Promise<EmbeddingStatus> {
    const { model, dim } = options.readConfig().embedding;
    const reembed = readState();
    if (!model) {
      return { model: null, dim: null, reembed, missing: 0, stale: 0, other: await silo.embedding.count() };
    }
    const [missing, stale, other] = await Promise.all([
      domain.embeddings.memoriesMissingEmbedding(silo, model, dim),
      domain.embeddings.memoriesWithStaleEmbedding(silo, model),
      silo.embedding.count({
        where: dim === null ? { model: { not: model } } : { OR: [{ model: { not: model } }, { dim: { not: dim } }] },
      }),
    ]);
    return { model, dim, reembed, missing: missing.length, stale: stale.length, other };
  }

  return { set, resume, status };
}

export type EmbeddingHook = ReturnType<typeof createEmbeddingHook>;
