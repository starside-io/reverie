import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startMiniHost, type MiniHost } from "@reverie/mini-host";

/**
 * The recall quality evals. docs/SPEC.md section 16, "Quality evals,
 * separate from gates": a fixture corpus of invented people in the five
 * abilities LongMemEval names, run with FTS only and with vectors, so the
 * cost of having no embedding model is a known number.
 *
 * Scores, not gates: nothing here fails on a number. The runner builds a
 * throwaway silo in a temp folder (never the live one), writes the corpus
 * through the registry the way an assistant would (memory.remember, and
 * memory.supersede for a knowledge update), then asks every question with
 * memory.recall: once on FTS alone, and once per embedder after switching
 * embedding.model through the settings port, which runs the real re-embed
 * hook. Every write and every recall runs at a pinned time, so a run with
 * the built-in embedder gives the same numbers on every machine.
 */

export interface EvalMemory {
  key: string;
  /** The call number the silo must issue for it. The runner checks. */
  call: string;
  kind: "fact" | "preference" | "episode" | "reference";
  shelf: string;
  occurredOn: string;
  title: string;
  body: string;
  tags?: string[];
  importance?: number;
  /** The call number of the entry this one replaces. Written with memory.supersede. */
  supersedes?: string;
}

export type EvalAbility = "extraction" | "multi_session" | "temporal" | "knowledge_update" | "abstention";

export interface EvalQuestion {
  id: string;
  ability: EvalAbility;
  query: string;
  /** The call numbers a good recall returns. Absent for an abstention case. */
  expect?: string[];
  /** True when nothing in the corpus answers it: recall should return sufficient false. */
  abstain?: boolean;
  /** For a knowledge update: the superseded entries that must not win. */
  superseded?: string[];
  asOf?: string;
}

export interface EvalCorpus {
  name: string;
  version: number;
  now: string;
  memories: EvalMemory[];
  questions: EvalQuestion[];
}

/** The k values recall at k is reported for. Starting value; recall.maxItems is 8. */
export const EVAL_K = [1, 3, 5] as const;

export interface QuestionOutcome {
  id: string;
  ability: EvalAbility;
  sufficient: boolean;
  /** Returned call numbers, best first. */
  calls: string[];
  /** Whether the vector search ran for this recall. Null when recall abstained, which reports no retrieval block. */
  vectors: boolean | null;
  ftsOnlyReason: string | null;
}

export interface Scores {
  questions: number;
  /** Questions with an answer in the corpus. */
  answerable: number;
  recallAt: Record<string, number | null>;
  mrr: number | null;
  /** Answerable questions recall abstained on. */
  falseAbstentions: number;
  /** Questions with nothing to find. */
  shouldAbstain: number;
  abstained: number;
  abstentionPrecision: number | null;
  abstentionRecall: number | null;
  /** Knowledge updates where a superseded entry ranked above every expected one. */
  staleWins: number;
}

export interface EvalRun {
  label: string;
  model: string | null;
  dim: number | null;
  /** Recalls that answered with the vector search, of those that answered. */
  vectorRecalls: { used: number; answered: number };
  overall: Scores;
  byAbility: Record<EvalAbility, Scores>;
  outcomes: QuestionOutcome[];
}

export interface EvalReport {
  corpus: { name: string; version: number; sha256: string; memories: number; questions: number; now: string };
  date: string;
  runs: EvalRun[];
}

const ABILITIES: readonly EvalAbility[] = ["extraction", "multi_session", "temporal", "knowledge_update", "abstention"];

export function loadCorpus(path: string): { corpus: EvalCorpus; sha256: string } {
  const text = readFileSync(path, "utf8");
  const corpus = JSON.parse(text) as EvalCorpus;
  const problems: string[] = [];
  if (!Array.isArray(corpus.memories) || corpus.memories.length === 0) problems.push("no memories");
  if (!Array.isArray(corpus.questions) || corpus.questions.length === 0) problems.push("no questions");
  const calls = new Set((corpus.memories ?? []).map((memory) => memory.call));
  for (const question of corpus.questions ?? []) {
    if (!ABILITIES.includes(question.ability)) problems.push(`${question.id}: unknown ability ${question.ability}`);
    if (question.abstain ? (question.expect?.length ?? 0) > 0 : (question.expect?.length ?? 0) === 0) {
      problems.push(`${question.id}: an abstention case expects nothing, every other case expects something`);
    }
    for (const call of [...(question.expect ?? []), ...(question.superseded ?? [])]) {
      if (!calls.has(call)) problems.push(`${question.id}: ${call} is not a memory in the corpus`);
    }
  }
  if (problems.length > 0) throw new Error(`The eval corpus at ${path} is not usable: ${problems.join("; ")}`);
  return { corpus, sha256: createHash("sha256").update(text).digest("hex") };
}

const noon = (day: string) => new Date(`${day}T12:00:00.000Z`);

async function buildLibrary(host: MiniHost, corpus: EvalCorpus): Promise<void> {
  const ordered = [...corpus.memories].sort((a, b) => (a.occurredOn < b.occurredOn ? -1 : a.occurredOn > b.occurredOn ? 1 : 0));
  for (const memory of ordered) {
    const now = noon(memory.occurredOn);
    const common = {
      title: memory.title,
      body: memory.body,
      occurredOn: memory.occurredOn,
      ...(memory.tags ? { tags: memory.tags } : {}),
      ...(memory.importance ? { importance: memory.importance } : {}),
    };
    const issued = memory.supersedes
      ? ((await host.api.invoke("memory.supersede", { call: memory.supersedes, ...common }, { now })) as { replacement: { call: string } }).replacement.call
      : ((await host.api.invoke("memory.remember", { kind: memory.kind, shelf: memory.shelf, ...common }, { now })) as { memory: { call: string } }).memory.call;
    if (issued !== memory.call) {
      throw new Error(`The corpus expects ${memory.key} at ${memory.call}, and the silo issued ${issued}. Fix the corpus.`);
    }
  }
}

async function askAll(host: MiniHost, corpus: EvalCorpus): Promise<QuestionOutcome[]> {
  const now = new Date(corpus.now);
  const outcomes: QuestionOutcome[] = [];
  for (const question of corpus.questions) {
    const result = (await host.api.invoke(
      "memory.recall",
      { query: question.query, ...(question.asOf ? { asOf: question.asOf } : {}) },
      { now },
    )) as
      | { sufficient: true; items: Array<{ call: string }>; retrieval: { vectors: boolean; ftsOnlyReason?: string } }
      | { sufficient: false; items: [] };
    outcomes.push({
      id: question.id,
      ability: question.ability,
      sufficient: result.sufficient,
      calls: result.items.map((item) => item.call),
      vectors: result.sufficient ? result.retrieval.vectors : null,
      ftsOnlyReason: result.sufficient ? (result.retrieval.ftsOnlyReason ?? null) : null,
    });
  }
  return outcomes;
}

const mean = (values: number[]): number | null => (values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length);

export function score(questions: readonly EvalQuestion[], outcomes: readonly QuestionOutcome[]): Scores {
  const byId = new Map(outcomes.map((outcome) => [outcome.id, outcome]));
  const recallAt: Record<number, number[]> = Object.fromEntries(EVAL_K.map((k) => [k, [] as number[]]));
  const reciprocal: number[] = [];
  let falseAbstentions = 0;
  let shouldAbstain = 0;
  let abstained = 0;
  let correctAbstentions = 0;
  let staleWins = 0;

  for (const question of questions) {
    const outcome = byId.get(question.id);
    if (!outcome) continue;
    if (!outcome.sufficient) abstained += 1;
    if (question.abstain) {
      shouldAbstain += 1;
      if (!outcome.sufficient) correctAbstentions += 1;
      continue;
    }
    if (!outcome.sufficient) falseAbstentions += 1;
    const expected = new Set(question.expect ?? []);
    for (const k of EVAL_K) {
      const top = outcome.calls.slice(0, k);
      recallAt[k]!.push(top.filter((call) => expected.has(call)).length / expected.size);
    }
    const first = outcome.calls.findIndex((call) => expected.has(call));
    reciprocal.push(first === -1 ? 0 : 1 / (first + 1));
    if (question.superseded?.length) {
      const stale = outcome.calls.findIndex((call) => question.superseded!.includes(call));
      if (stale !== -1 && (first === -1 || stale < first)) staleWins += 1;
    }
  }

  const answerable = questions.filter((question) => !question.abstain).length;
  return {
    questions: questions.length,
    answerable,
    recallAt: Object.fromEntries(EVAL_K.map((k) => [`${k}`, mean(recallAt[k]!)])),
    mrr: mean(reciprocal),
    falseAbstentions,
    shouldAbstain,
    abstained,
    abstentionPrecision: abstained === 0 ? null : correctAbstentions / abstained,
    abstentionRecall: shouldAbstain === 0 ? null : correctAbstentions / shouldAbstain,
    staleWins,
  };
}

function runOf(label: string, model: string | null, dim: number | null, corpus: EvalCorpus, outcomes: QuestionOutcome[]): EvalRun {
  const answered = outcomes.filter((outcome) => outcome.sufficient);
  return {
    label,
    model,
    dim,
    vectorRecalls: { used: answered.filter((outcome) => outcome.vectors).length, answered: answered.length },
    overall: score(corpus.questions, outcomes),
    byAbility: Object.fromEntries(
      ABILITIES.map((ability) => [ability, score(corpus.questions.filter((question) => question.ability === ability), outcomes)]),
    ) as Record<EvalAbility, Scores>,
    outcomes,
  };
}

export interface EvalOptions {
  corpusPath: string;
  /** embedding.model values to run after FTS only, such as "reverie-lexical-v1" or "ollama/nomic-embed-text". */
  embedders: string[];
  /** For the endpoint embedders: a loopback base URL. Defaults to each kind's local port. */
  endpoint?: string;
  /** Progress lines. */
  log?: (line: string) => void;
}

/** Builds a throwaway silo, runs every question FTS only and with each embedder, and scores it. */
export async function runEval(options: EvalOptions): Promise<EvalReport> {
  const { corpus, sha256 } = loadCorpus(options.corpusPath);
  const log = options.log ?? (() => undefined);
  const dir = mkdtempSync(join(tmpdir(), "reverie-eval-"));
  // Both files in the temp folder, and an env with nothing in it: the live
  // silo's path is never read, so it cannot be opened by accident.
  const host = await startMiniHost({
    dbPath: join(dir, "reverie.db"),
    hostDbPath: join(dir, "host.db"),
    env: {},
    transcripts: false,
    ...(options.endpoint ? { embedders: { endpoint: options.endpoint } } : {}),
  });
  try {
    log(`Building a throwaway silo of ${corpus.memories.length} memories in ${dir}`);
    await buildLibrary(host, corpus);

    const runs: EvalRun[] = [];
    log("Asking FTS only");
    runs.push(runOf("FTS only", null, null, corpus, await askAll(host, corpus)));

    for (const model of options.embedders) {
      log(`Re-embedding with ${model}`);
      await host.ports.settings.set({ embedding: { model, dim: null } });
      const applied = host.config().embedding;
      log(`Asking with ${model} (dim ${applied.dim ?? "?"})`);
      runs.push(runOf(`FTS + ${model}`, applied.model, applied.dim, corpus, await askAll(host, corpus)));
    }

    return {
      corpus: {
        name: corpus.name,
        version: corpus.version,
        sha256,
        memories: corpus.memories.length,
        questions: corpus.questions.length,
        now: corpus.now,
      },
      date: new Date().toISOString().slice(0, 10),
      runs,
    };
  } finally {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const fixed = (value: number | null) => (value === null ? "n/a" : value.toFixed(3));

/** The results as a markdown page: one table overall, one per ability. */
export function formatReport(report: EvalReport): string {
  const head = ["", ...report.runs.map((run) => run.label)];
  const table = (rows: string[][]) =>
    [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...rows.map((row) => `| ${row.join(" | ")} |`)].join("\n");
  const metricRows = (pick: (run: EvalRun) => Scores, abstentionOnly = false): string[][] => {
    const rows: string[][] = [];
    if (!abstentionOnly) {
      for (const k of EVAL_K) rows.push([`recall@${k}`, ...report.runs.map((run) => fixed(pick(run).recallAt[`${k}`] ?? null))]);
      rows.push(["MRR", ...report.runs.map((run) => fixed(pick(run).mrr))]);
      rows.push(["false abstentions", ...report.runs.map((run) => `${pick(run).falseAbstentions} of ${pick(run).answerable}`)]);
    }
    if (abstentionOnly || pick(report.runs[0]!).shouldAbstain > 0) {
      rows.push(["abstention precision", ...report.runs.map((run) => fixed(pick(run).abstentionPrecision))]);
      rows.push(["abstention recall", ...report.runs.map((run) => fixed(pick(run).abstentionRecall))]);
    }
    return rows;
  };

  const lines = [
    "# Recall evals",
    "",
    "Scores, not gates (docs/SPEC.md section 16). Written by `reverie eval`; see the README for how to run it.",
    "",
    `- corpus: ${report.corpus.name} v${report.corpus.version}, ${report.corpus.memories} memories, ${report.corpus.questions} questions`,
    `- corpus sha256: ${report.corpus.sha256}`,
    `- recall at: ${report.corpus.now}`,
    `- run on: ${report.date}`,
    ...report.runs.map(
      (run) =>
        `- ${run.label}: model ${run.model ?? "none"}, dim ${run.dim ?? "none"}, vector search ran on ${run.vectorRecalls.used} of ${run.vectorRecalls.answered} recalls that answered`,
    ),
    "",
    "Recall at k is the share of a question's expected call numbers in the first k items returned; MRR is the mean of 1 over the rank of the first expected item (0 when none is returned). Abstention precision is the share of abstentions that were right; abstention recall the share of unanswerable questions that abstained. Defaults as shipped: floor 0.35, maxItems 8, tokenBudget 1200, k 60 in the fusion, half-lives fact 365, preference 730, episode 90, reference 365.",
    "",
    "## Overall",
    "",
    table(metricRows((run) => run.overall)),
    "",
  ];
  for (const ability of ABILITIES) {
    const sample = report.runs[0]!.byAbility[ability];
    lines.push(`## ${ability.replace("_", " ")} (${sample.questions} questions)`, "");
    lines.push(table(metricRows((run) => run.byAbility[ability], ability === "abstention")));
    if (ability === "knowledge_update") {
      lines.push("", `Superseded entry ranked above the current one: ${report.runs.map((run) => `${run.label} ${run.byAbility[ability].staleWins}`).join(", ")}.`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/** Writes results.json and RESULTS.md into `dir`. */
export function writeReport(report: EvalReport, dir: string): { json: string; markdown: string } {
  mkdirSync(dir, { recursive: true });
  const json = join(dir, "results.json");
  const markdown = join(dir, "RESULTS.md");
  writeFileSync(json, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(markdown, formatReport(report));
  return { json, markdown };
}
