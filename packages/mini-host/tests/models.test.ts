import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { domain } from "@reverie/core";

import {
  createEndpointEmbedder,
  createLexicalEmbedder,
  embedUrl,
  LEXICAL_DEFAULT_DIM,
  LEXICAL_MODEL,
  lexicalVector,
  loopbackUrl,
  parseModelName,
  resolveEmbedder,
} from "../src/models/index.js";
import { createPorts } from "../src/ports/index.js";
import { throwawayHost } from "./harness.js";

/**
 * The mini-host's models port (docs/SPEC.md section 12): the built-in
 * lexical baseline, and the local endpoint embedders, which talk to loopback
 * only. Every endpoint here is a server this test starts on 127.0.0.1, or a
 * fetch double; nothing leaves the machine. All text is invented.
 */

const norm = (vector: number[]) => Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
const cosine = (a: number[], b: number[]) => domain.queries.cosine(a, b) ?? 0;

describe("the built-in lexical embedder", () => {
  it("is deterministic, unit length, and of the dim asked", async () => {
    const embed = createLexicalEmbedder(256);
    const [a, b] = await embed(["Jane Doe keeps bees in Elmwood.", "Jane Doe keeps bees in Elmwood."]);
    expect(a).toHaveLength(256);
    expect(a).toEqual(b);
    expect(norm(a!)).toBeCloseTo(1, 6);
    expect(lexicalVector("Sam Rivera rides a cargo bike.", LEXICAL_DEFAULT_DIM)).toEqual(
      lexicalVector("Sam Rivera rides a cargo bike.", LEXICAL_DEFAULT_DIM),
    );
  });

  it("puts texts that share words and word stems closer than texts that share none", () => {
    const base = lexicalVector("Planted garlic in the raised garden beds.", 512);
    const stem = lexicalVector("Gardening with raised beds and garlic.", 512);
    const other = lexicalVector("The boiler reset button sits behind a panel.", 512);
    expect(cosine(base, stem)).toBeGreaterThan(cosine(base, other));
    expect(cosine(base, stem)).toBeGreaterThan(0.3);
  });

  it("gives the zero vector for a text with no content word", () => {
    expect(norm(lexicalVector("the and of it", 64))).toBe(0);
  });

  it("refuses a dim outside 16 to 4096", () => {
    expect(() => createLexicalEmbedder(8)).toThrow(/16 to 4096/);
    expect(resolveEmbedder(LEXICAL_MODEL, 5000)).toMatch(/16 to 4096/);
  });
});

describe("model names", () => {
  it("knows the built-in one and the two endpoint kinds, and nothing else", () => {
    expect(parseModelName("reverie-lexical-v1")).toEqual({ kind: "lexical" });
    expect(parseModelName("ollama/nomic-embed-text")).toEqual({ kind: "ollama", name: "nomic-embed-text" });
    expect(parseModelName("openai/bge-small-en:q8")).toEqual({ kind: "openai", name: "bge-small-en:q8" });
    expect(parseModelName("nomic-embed-text")).toBeNull();
    expect(parseModelName("ollama/")).toBeNull();
    expect(resolveEmbedder("text-embedding-3-small", null)).toMatch(/does not know/);
  });

  it("gives the lexical embedder 512 values when config leaves dim open", () => {
    const embedder = resolveEmbedder(LEXICAL_MODEL, null);
    expect(typeof embedder).not.toBe("string");
    expect((embedder as { defaultDim: number }).defaultDim).toBe(512);
  });
});

describe("the loopback rule", () => {
  it("takes 127.0.0.1, localhost and ::1, over http or https", () => {
    for (const url of ["http://127.0.0.1:11434", "http://localhost:8080/v1", "http://[::1]:1234", "https://localhost"]) {
      expect(() => loopbackUrl(url)).not.toThrow();
    }
  });

  it("refuses every other host, before any request is made", async () => {
    const refused = [
      "http://192.168.1.20:11434",
      "http://10.0.0.5:8080",
      "http://embeddings.example.com",
      "http://127.0.0.2:11434",
      "http://0.0.0.0:11434",
      "http://localhost.example.com:11434",
    ];
    let requests = 0;
    const counting = (async () => {
      requests += 1;
      return new Response("{}");
    }) as unknown as typeof fetch;
    for (const url of refused) {
      expect(() => loopbackUrl(url)).toThrow(/must be on this machine/);
      expect(() => createEndpointEmbedder({ kind: "ollama", model: "nomic-embed-text", url, fetch: counting })).toThrow(
        /must be on this machine/,
      );
      expect(resolveEmbedder("ollama/nomic-embed-text", null, { endpoint: url })).toMatch(/must be on this machine/);
    }
    expect(requests).toBe(0);
  });

  it("refuses a URL with a user name or password, and one that is not http", () => {
    expect(() => loopbackUrl("http://jane:secret@127.0.0.1:11434")).toThrow(/user name or password/);
    expect(() => loopbackUrl("file:///tmp/model")).toThrow(/http or https/);
    expect(() => loopbackUrl("not a url")).toThrow(/not a URL/);
  });

  it("reads REVERIE_EMBED_URL and refuses it when it is not loopback", () => {
    expect(resolveEmbedder("ollama/nomic-embed-text", null, { env: { REVERIE_EMBED_URL: "http://203.0.113.7:11434" } })).toMatch(
      /must be on this machine/,
    );
    expect(typeof resolveEmbedder("ollama/nomic-embed-text", null, { env: { REVERIE_EMBED_URL: "http://127.0.0.1:9" } })).not.toBe(
      "string",
    );
  });

  it("builds the request path for each kind", () => {
    expect(embedUrl("ollama", new URL("http://127.0.0.1:11434")).toString()).toBe("http://127.0.0.1:11434/api/embed");
    expect(embedUrl("openai", new URL("http://127.0.0.1:8080")).toString()).toBe("http://127.0.0.1:8080/v1/embeddings");
    expect(embedUrl("openai", new URL("http://127.0.0.1:1234/v1")).toString()).toBe("http://127.0.0.1:1234/v1/embeddings");
  });
});

describe("the endpoint embedders, against a local server", () => {
  let server: Server | null = null;
  afterEach(async () => {
    await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
    server = null;
  });

  async function serve(handler: (path: string, body: Record<string, unknown>) => { status: number; json?: unknown; redirect?: string; hang?: boolean }) {
    server = createServer((request, response) => {
      let raw = "";
      request.on("data", (chunk) => (raw += chunk));
      request.on("end", () => {
        const answer = handler(request.url ?? "", raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
        if (answer.hang) return;
        if (answer.redirect) {
          response.writeHead(307, { location: answer.redirect });
          response.end();
          return;
        }
        response.writeHead(answer.status, { "content-type": "application/json" });
        response.end(JSON.stringify(answer.json ?? {}));
      });
    });
    await new Promise<void>((done) => server!.listen(0, "127.0.0.1", () => done()));
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  }

  it("speaks Ollama's /api/embed", async () => {
    const seen: Array<{ path: string; body: Record<string, unknown> }> = [];
    const url = await serve((path, body) => {
      seen.push({ path, body });
      return { status: 200, json: { embeddings: (body["input"] as string[]).map((_, index) => [index, 1]) } };
    });
    const embed = createEndpointEmbedder({ kind: "ollama", model: "nomic-embed-text", url });
    expect(await embed(["Jane Doe", "John Doe"])).toEqual([
      [0, 1],
      [1, 1],
    ]);
    expect(seen).toEqual([{ path: "/api/embed", body: { model: "nomic-embed-text", input: ["Jane Doe", "John Doe"] } }]);
  });

  it("speaks the OpenAI embeddings shape, in index order", async () => {
    const url = await serve(() => ({
      status: 200,
      json: { data: [{ index: 1, embedding: [0, 2] }, { index: 0, embedding: [1, 0] }] },
    }));
    const embed = createEndpointEmbedder({ kind: "openai", model: "bge-small", url });
    expect(await embed(["a", "b"])).toEqual([
      [1, 0],
      [0, 2],
    ]);
  });

  it("says clearly when the model is missing, the answer is malformed, or nothing listens", async () => {
    const url = await serve((path) => (path === "/api/embed" ? { status: 404, json: { error: "model not found" } } : { status: 200 }));
    await expect(createEndpointEmbedder({ kind: "ollama", model: "absent-model", url })(["x"])).rejects.toThrow(
      /answered 404\. Is the model "absent-model" present on it\?/,
    );

    const short = await serve(() => ({ status: 200, json: { embeddings: [[1, 2]] } }));
    await expect(createEndpointEmbedder({ kind: "ollama", model: "m", url: short })(["a", "b"])).rejects.toThrow(/1 vectors for 2 texts/);

    await expect(createEndpointEmbedder({ kind: "ollama", model: "m", url: "http://127.0.0.1:9" })(["a"])).rejects.toThrow(
      /Nothing answered at http:\/\/127\.0\.0\.1:9\/api\/embed/,
    );
  });

  it("times out, and never follows a redirect off the machine", async () => {
    const slow = await serve(() => ({ status: 200, hang: true }));
    await expect(createEndpointEmbedder({ kind: "ollama", model: "m", url: slow, timeoutMs: 100 })(["a"])).rejects.toThrow(
      /no answer within 100ms/,
    );
    await new Promise<void>((done) => server!.close(() => done()));
    server = null;

    let followed = false;
    const away = await serve((path) => {
      if (path !== "/api/embed") followed = true;
      return { status: 200, redirect: "http://203.0.113.7/api/embed" };
    });
    await expect(createEndpointEmbedder({ kind: "ollama", model: "m", url: away })(["a"])).rejects.toThrow();
    expect(followed).toBe(false);
  });

  it("a host configured with a remote endpoint refuses the model and stores nothing", async () => {
    const host = await throwawayHost();
    try {
      await host.api.invoke("memory.remember", { kind: "fact", shelf: "LIF/HOM", body: "Sam Rivera keeps the tent." });
      const env = { REVERIE_EMBED_URL: "http://203.0.113.7:11434" };
      const ports = createPorts({ silo: host.silo, store: host.store, embedders: { env } });
      await expect(ports.ports.settings.set({ embedding: { model: "ollama/nomic-embed-text", dim: null } })).rejects.toThrow(
        /must be on this machine/,
      );
      expect(ports.readConfig().embedding.model).toBeNull();
      expect(await host.silo.embedding.count()).toBe(0);
    } finally {
      await host.close();
    }
  });
});
