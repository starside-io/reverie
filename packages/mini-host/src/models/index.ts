import type { ModelsPort, ModuleConfig } from "@reverie/core";

import { createEndpointEmbedder, DEFAULT_ENDPOINTS, ENDPOINT_TIMEOUT_MS, type EndpointKind } from "./endpoint.js";
import { checkLexicalDim, createLexicalEmbedder, LEXICAL_DEFAULT_DIM, LEXICAL_MODEL } from "./lexical.js";

export * from "./endpoint.js";
export * from "./lexical.js";

/**
 * The mini-host's models port (docs/SPEC.md section 12: optional, `embed()`
 * only). Off by default: with `embedding.model` null in config nothing here
 * runs and recall stays on FTS alone. What `embedding.model` may name:
 *
 *   reverie-lexical-v1   the built-in lexical baseline (lexical.ts): no
 *                        network, no download, any dim from 16 to 4096,
 *                        512 when config leaves dim null
 *   ollama/<model>       an Ollama server on loopback, /api/embed
 *   openai/<model>       an OpenAI-compatible server on loopback,
 *                        /v1/embeddings (llama.cpp, LM Studio, vLLM)
 *
 * The endpoint URL is the host's, not the library's: REVERIE_EMBED_URL, else
 * the kind's default port on 127.0.0.1. It is checked to be loopback when the
 * embedder is made, so a refused host is never sent a request.
 */

/** The environment variable that points the endpoint embedders at a server. */
export const EMBED_URL_ENV = "REVERIE_EMBED_URL";

export interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
  /** The dim this embedder gives when config leaves it null, when it knows: the lexical one does, an endpoint's is learnt from its first vector. */
  defaultDim: number | null;
}

export interface EmbedderSettings {
  env?: NodeJS.ProcessEnv;
  /** Overrides REVERIE_EMBED_URL. */
  endpoint?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** What a model name asks for, or null when it names nothing this host knows. */
export function parseModelName(model: string): { kind: "lexical" } | { kind: EndpointKind; name: string } | null {
  if (model === LEXICAL_MODEL) return { kind: "lexical" };
  const match = /^(ollama|openai)\/(.+)$/.exec(model);
  if (match && match[2]!.trim().length > 0) return { kind: match[1] as EndpointKind, name: match[2]!.trim() };
  return null;
}

/**
 * The embedder for a model and dim, or the reason there is none: a name this
 * host does not know, a dim the lexical embedder cannot give, an endpoint
 * that is not on loopback.
 */
export function resolveEmbedder(model: string, dim: number | null, settings: EmbedderSettings = {}): Embedder | string {
  const parsed = parseModelName(model);
  if (!parsed) {
    return `This host does not know the embedding model "${model}". It takes ${LEXICAL_MODEL} (built in), ollama/<model> or openai/<model> on a local endpoint.`;
  }
  if (parsed.kind === "lexical") {
    const use = dim ?? LEXICAL_DEFAULT_DIM;
    const problem = checkLexicalDim(use);
    if (problem) return problem;
    return { embed: createLexicalEmbedder(use), defaultDim: use };
  }
  const url = settings.endpoint ?? settings.env?.[EMBED_URL_ENV]?.trim() ?? DEFAULT_ENDPOINTS[parsed.kind];
  try {
    const embed = createEndpointEmbedder({
      kind: parsed.kind,
      model: parsed.name,
      url: url || DEFAULT_ENDPOINTS[parsed.kind],
      timeoutMs: settings.timeoutMs ?? ENDPOINT_TIMEOUT_MS,
      ...(settings.fetch ? { fetch: settings.fetch } : {}),
    });
    return { embed, defaultDim: dim };
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * The models port core calls: it embeds with the model config has applied.
 * An embedder is made once per model, dim and endpoint and reused. The
 * re-embed hook does not go through this port, because while it runs config
 * still names the old model; it asks resolveEmbedder for the new one.
 */
export function createHostModels(readConfig: () => ModuleConfig, settings: EmbedderSettings = {}): ModelsPort {
  let cached: { key: string; embedder: Embedder } | null = null;
  return {
    embed: async (texts) => {
      const { model, dim } = readConfig().embedding;
      if (!model) throw new Error("No embedding model is configured.");
      const key = `${model}\u0000${dim ?? ""}`;
      if (!cached || cached.key !== key) {
        const resolved = resolveEmbedder(model, dim, settings);
        if (typeof resolved === "string") throw new Error(resolved);
        cached = { key, embedder: resolved };
      }
      return cached.embedder.embed(texts);
    },
  };
}
