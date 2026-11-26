import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { startMiniHost } from "@reverie/mini-host";

import { loadCorpus, runEval, type EvalCorpus } from "../src/eval.js";
import { defaultCorpusPath, run, type Io } from "../src/main.js";

/**
 * M8 on the binary: `reverie reindex` brings the vectors up to date as well
 * as the search index, `reverie status` says how recall finds candidates, and
 * `reverie eval` runs (a smoke test: scores are never asserted, because evals
 * are scores, not gates). Throwaway files only; every name is invented.
 */

function throwawayIo(): Io & { stdout: string; stderr: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "reverie-cli-vectors-"));
  const io = {
    dir,
    stdout: "",
    stderr: "",
    env: { REVERIE_DB_PATH: join(dir, "reverie.db"), REVERIE_HOST_DB_PATH: join(dir, "host.db") } as NodeJS.ProcessEnv,
    cwd: dir,
    out: (text: string) => {
      io.stdout += text;
    },
    err: (text: string) => {
      io.stderr += text;
    },
  };
  return io;
}

describe("reverie reindex covers vectors", () => {
  it("says vectors are off with no model, and fills missing and stale ones with one", async () => {
    const io = throwawayIo();
    const host = await startMiniHost({ env: io.env });
    let ids: string[] = [];
    try {
      for (const body of ["Sam Rivera keeps the tent in Ashgrove.", "John Doe lends the camping stove.", "Jane Doe packs the map."]) {
        ids.push(((await host.api.invoke("memory.remember", { kind: "fact", shelf: "LIF/TRV", body })) as { memory: { id: string } }).memory.id);
      }
    } finally {
      await host.close();
    }
    expect(await run(["reindex"], io)).toBe(0);
    expect(io.stdout).toContain("vectors   off: no embedding model");

    const on = await startMiniHost({ env: io.env });
    try {
      await on.ports.settings.set({ embedding: { model: "reverie-lexical-v1", dim: 64 } });
      // One vector lost, one left from before its memory's last edit.
      await on.silo.embedding.delete({ where: { memoryId: ids[0]! } });
      await on.silo.embedding.update({ where: { memoryId: ids[1]! }, data: { createdAt: new Date("2000-01-01T00:00:00.000Z") } });
    } finally {
      await on.close();
    }

    io.stdout = "";
    expect(await run(["status"], io)).toBe(0);
    expect(io.stdout).toMatch(/recall\s+full text only until 1 missing vectors of reverie-lexical-v1 are filled/);

    io.stdout = "";
    expect(await run(["reindex"], io)).toBe(0);
    expect(io.stdout).toMatch(/vectors\s+reverie-lexical-v1 \(dim 64\): 2 written, 0 of another model or dim removed/);

    io.stdout = "";
    expect(await run(["status"], io)).toBe(0);
    expect(io.stdout).toMatch(/recall\s+vectors \(reverie-lexical-v1, dim 64\) and full text/);
  });
});

describe("reverie eval", () => {
  it("the committed corpus is big enough to say something, and every expectation names a memory in it", () => {
    const { corpus, sha256 } = loadCorpus(defaultCorpusPath());
    expect(corpus.memories.length).toBeGreaterThanOrEqual(60);
    expect(corpus.questions.length).toBeGreaterThanOrEqual(50);
    expect(new Set(corpus.questions.map((question) => question.ability))).toEqual(
      new Set(["extraction", "multi_session", "temporal", "knowledge_update", "abstention"]),
    );
    expect(corpus.questions.filter((question) => question.ability === "knowledge_update").every((question) => question.superseded?.length)).toBe(true);
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("runs a small corpus FTS only and with the built-in embedder, in a throwaway silo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reverie-eval-smoke-"));
    const small: EvalCorpus = {
      name: "smoke",
      version: 1,
      now: "2026-11-20T12:00:00.000Z",
      memories: [
        { key: "tent", call: "LIF/TRV/2026-03-01/001", kind: "fact", shelf: "LIF/TRV", occurredOn: "2026-03-01", title: "Tent", body: "Sam Rivera keeps the tent in his loft." },
        { key: "old", call: "LIF/HOM/2026-03-02/001", kind: "fact", shelf: "LIF/HOM", occurredOn: "2026-03-02", title: "Birch Row", body: "I live at 12 Birch Row in Elmwood." },
        { key: "new", call: "LIF/HOM/2026-06-14/001", kind: "fact", shelf: "LIF/HOM", occurredOn: "2026-06-14", title: "Larkspur Lane", body: "Moved to 7 Larkspur Lane in Millbrook.", supersedes: "LIF/HOM/2026-03-02/001" },
      ],
      questions: [
        { id: "x1", ability: "extraction", query: "who keeps the tent", expect: ["LIF/TRV/2026-03-01/001"] },
        { id: "k1", ability: "knowledge_update", query: "where do I live", expect: ["LIF/HOM/2026-06-14/001"], superseded: ["LIF/HOM/2026-03-02/001"] },
        { id: "a1", ability: "abstention", query: "zzzz qqqq", abstain: true },
      ],
    };
    const path = join(dir, "corpus.json");
    writeFileSync(path, JSON.stringify(small));
    const report = await runEval({ corpusPath: path, embedders: ["reverie-lexical-v1"] });
    expect(report.runs.map((entry) => entry.label)).toEqual(["FTS only", "FTS + reverie-lexical-v1"]);
    expect(report.runs[1]).toMatchObject({ model: "reverie-lexical-v1", dim: 512 });
    expect(report.runs[1]!.vectorRecalls.used).toBe(report.runs[1]!.vectorRecalls.answered);
    expect(report.runs[0]!.overall.questions).toBe(3);
    expect(Object.keys(report.runs[0]!.byAbility).sort()).toEqual(["abstention", "extraction", "knowledge_update", "multi_session", "temporal"]);

    // Through the binary, writing the two result files.
    const io = throwawayIo();
    expect(await run(["eval", "--corpus", path, "--out", join(dir, "out")], io)).toBe(0);
    expect(io.stdout).toContain("| recall@1 |");
    expect(readFileSync(join(dir, "out", "RESULTS.md"), "utf8")).toContain("FTS + reverie-lexical-v1");
    expect(JSON.parse(readFileSync(join(dir, "out", "results.json"), "utf8")).corpus.sha256).toMatch(/^[0-9a-f]{64}$/);
  }, 60_000);

  it("refuses a corpus whose expectations name no memory, and exits 1 without a score", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reverie-eval-bad-"));
    const path = join(dir, "corpus.json");
    writeFileSync(path, JSON.stringify({ name: "bad", version: 1, now: "2026-11-20T12:00:00.000Z", memories: [{ key: "a", call: "LIF/HOM/2026-01-01/001", kind: "fact", shelf: "LIF/HOM", occurredOn: "2026-01-01", title: "A", body: "Jane Doe." }], questions: [{ id: "q", ability: "extraction", query: "x", expect: ["LIF/HOM/2026-01-02/001"] }] }));
    const io = throwawayIo();
    expect(await run(["eval", "--corpus", path], io)).toBe(1);
    expect(io.stderr).toMatch(/is not a memory in the corpus/);
  });
});
