/**
 * A real local embedding model, through an HTTP endpoint on this machine:
 * Ollama's `/api/embed`, or any server that speaks the OpenAI embeddings
 * shape (`/v1/embeddings`: llama.cpp's server, LM Studio, vLLM and the like).
 *
 * Loopback only. module.json declares `"network": "none"`, and a memory's
 * body is the most private thing this host holds, so the endpoint must be
 * 127.0.0.1, localhost or ::1. Any other host is refused before a request is
 * made, a redirect is refused rather than followed (it could point off the
 * machine), and a URL carrying a user name or password is refused. There are
 * no API keys and no remote providers: nothing here sends an Authorization
 * header, and nothing reads a key from the environment.
 */

export type EndpointKind = "ollama" | "openai";

/** Where each kind listens by default. */
export const DEFAULT_ENDPOINTS: Readonly<Record<EndpointKind, string>> = {
  ollama: "http://127.0.0.1:11434",
  openai: "http://127.0.0.1:8080",
};

/** How long one embed request may take before it fails. Starting value. */
export const ENDPOINT_TIMEOUT_MS = 30_000;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export class EmbedderError extends Error {
  readonly code: "not_loopback" | "bad_url" | "unreachable" | "timeout" | "http_error" | "bad_response";
  constructor(code: EmbedderError["code"], message: string) {
    super(message);
    this.name = "EmbedderError";
    this.code = code;
  }
}

/** The URL, parsed, when it is a plain http(s) URL on loopback. Throws otherwise. */
export function loopbackUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new EmbedderError("bad_url", `"${raw}" is not a URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new EmbedderError("bad_url", `An embeddings endpoint is http or https; "${url.protocol}" is neither.`);
  }
  if (url.username || url.password) {
    throw new EmbedderError("bad_url", "An embeddings endpoint URL may not carry a user name or password.");
  }
  if (!LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) {
    throw new EmbedderError(
      "not_loopback",
      `Refused: the embeddings endpoint must be on this machine (127.0.0.1, localhost or ::1), and "${url.hostname}" is not. Reverie declares network none: no memory leaves the machine.`,
    );
  }
  return url;
}

function join(base: URL, path: string): URL {
  const url = new URL(base.toString());
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${path}`;
  url.search = "";
  url.hash = "";
  return url;
}

/** The request URL for a kind: Ollama's /api/embed, or /v1/embeddings (a base already ending in /v1 is kept). */
export function embedUrl(kind: EndpointKind, base: URL): URL {
  if (kind === "ollama") return join(base, "/api/embed");
  return /\/v1\/?$/.test(base.pathname) ? join(base, "/embeddings") : join(base, "/v1/embeddings");
}

function vectorsOf(kind: EndpointKind, body: unknown, count: number): number[][] {
  const fail = (detail: string) => new EmbedderError("bad_response", `The embeddings endpoint answered in a shape Reverie cannot read: ${detail}.`);
  if (!body || typeof body !== "object") throw fail("not a JSON object");
  let vectors: unknown;
  if (kind === "ollama") {
    vectors = (body as { embeddings?: unknown }).embeddings;
  } else {
    const data = (body as { data?: unknown }).data;
    if (!Array.isArray(data)) throw fail("no data array");
    vectors = [...data]
      .sort((a, b) => Number((a as { index?: number }).index ?? 0) - Number((b as { index?: number }).index ?? 0))
      .map((entry) => (entry as { embedding?: unknown }).embedding);
  }
  if (!Array.isArray(vectors)) throw fail("no list of vectors");
  if (vectors.length !== count) throw fail(`${vectors.length} vectors for ${count} texts`);
  for (const vector of vectors) {
    if (!Array.isArray(vector) || vector.length === 0 || !vector.every((value) => typeof value === "number" && Number.isFinite(value))) {
      throw fail("a vector that is not a list of numbers");
    }
  }
  return vectors as number[][];
}

export interface EndpointEmbedderOptions {
  kind: EndpointKind;
  /** The model name as the endpoint knows it, such as "nomic-embed-text". */
  model: string;
  /** The endpoint's base URL. Defaults to DEFAULT_ENDPOINTS[kind]. Must be loopback. */
  url?: string;
  timeoutMs?: number;
  /** For tests. Defaults to the global fetch. */
  fetch?: typeof fetch;
}

/**
 * An embed function over a loopback endpoint. The URL is checked here, once,
 * so a refused host fails when the embedder is made and no request is ever
 * sent to it.
 */
export function createEndpointEmbedder(options: EndpointEmbedderOptions): (texts: string[]) => Promise<number[][]> {
  const base = loopbackUrl(options.url ?? DEFAULT_ENDPOINTS[options.kind]);
  const target = embedUrl(options.kind, base);
  const timeoutMs = options.timeoutMs ?? ENDPOINT_TIMEOUT_MS;
  const doFetch = options.fetch ?? fetch;
  const where = `${target.protocol}//${target.host}${target.pathname}`;

  return async (texts) => {
    if (texts.length === 0) return [];
    let response: Response;
    try {
      response = await doFetch(target, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: options.model, input: texts }),
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const name = (error as { name?: string })?.name;
      if (name === "TimeoutError" || name === "AbortError") {
        throw new EmbedderError("timeout", `The embeddings endpoint at ${where} gave no answer within ${timeoutMs}ms.`);
      }
      throw new EmbedderError(
        "unreachable",
        `Nothing answered at ${where} (${error instanceof Error ? error.message : String(error)}). Is the local model server running?`,
      );
    }
    if (!response.ok) {
      // The status only: an error body may echo the texts it was sent, and a
      // reason ends up in tool results and host.db.
      throw new EmbedderError(
        "http_error",
        `The embeddings endpoint at ${where} answered ${response.status}. Is the model "${options.model}" present on it?`,
      );
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new EmbedderError("bad_response", `The embeddings endpoint at ${where} did not answer with JSON.`);
    }
    return vectorsOf(options.kind, body, texts.length);
  };
}
