/**
 * The built-in embedder: a lexical baseline, not a language model.
 *
 * It hashes a text's words, word pairs, word prefixes and character
 * trigrams into a fixed number of buckets (the hashing trick), with a sign
 * per feature so collisions cancel rather than pile up, then scales the
 * vector to unit length. Two texts are close when they share words, or the
 * stems and fragments of words ("garden" and "gardening", "Rivera" and
 * "Riveras"). Two texts that mean the same thing in different words are not
 * close at all: it knows no synonyms, no paraphrase and no language. It is
 * here so the vector path (storage, fusion, the re-embed hook, the evals)
 * runs anywhere, with no network, no download and no weights, and gives the
 * same vector for the same text on every machine. A real local model is the
 * endpoint embedder in endpoint.ts.
 *
 * Deterministic: no randomness, no clock, no locale. Pure TypeScript.
 */

export const LEXICAL_MODEL = "reverie-lexical-v1";

/** The dim used when config leaves embedding.dim null. Starting value. */
export const LEXICAL_DEFAULT_DIM = 512;
export const LEXICAL_MIN_DIM = 16;
export const LEXICAL_MAX_DIM = 4096;

/** Words that carry no topic. Kept short on purpose: the baseline should stay plain. */
const STOP_WORDS = new Set(
  (
    "a an and are as at be been but by did do does for from had has have he her his how i if in into is it its " +
    "me my of on or our she so that the their them then there they this to was we were what when where which " +
    "who whom why will with you your"
  ).split(" "),
);

const WEIGHT = { word: 1, pair: 0.6, prefix: 0.5, trigram: 0.25 } as const;
const PREFIX_LENGTH = 5;

/** FNV-1a, 32 bit. */
function fnv1a(text: string, seed = 0x811c9dc5): number {
  let hash = seed >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Lower case, accents folded, split on anything that is not a letter or a digit. */
export function lexicalTokens(text: string): string[] {
  return (
    text
      .normalize("NFKD")
      .replace(/\p{M}+/gu, "")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}

/** The weighted features of a text, before hashing. Exposed for tests. */
export function lexicalFeatures(text: string): Map<string, number> {
  const features = new Map<string, number>();
  const add = (feature: string, weight: number) => features.set(feature, (features.get(feature) ?? 0) + weight);
  const words = lexicalTokens(text).filter((word) => !STOP_WORDS.has(word));
  words.forEach((word, index) => {
    add(`w:${word}`, WEIGHT.word);
    if (word.length > PREFIX_LENGTH) add(`p:${word.slice(0, PREFIX_LENGTH)}`, WEIGHT.prefix);
    if (word.length >= 4) {
      const padded = `^${word}$`;
      for (let at = 0; at + 3 <= padded.length; at += 1) add(`t:${padded.slice(at, at + 3)}`, WEIGHT.trigram);
    }
    const next = words[index + 1];
    if (next) add(`b:${word} ${next}`, WEIGHT.pair);
  });
  return features;
}

/** One unit vector of `dim` values. A text with no content word gives the zero vector. */
export function lexicalVector(text: string, dim: number): number[] {
  const vector = new Array<number>(dim).fill(0);
  for (const [feature, weight] of lexicalFeatures(text)) {
    const bucket = fnv1a(feature) % dim;
    const sign = (fnv1a(feature, 0x9747b28c) & 1) === 1 ? 1 : -1;
    // Dampened term frequency: a word said five times is not five times the topic.
    vector[bucket] = (vector[bucket] as number) + sign * Math.sqrt(weight);
  }
  let norm = 0;
  for (const value of vector) norm += value * value;
  if (norm === 0) return vector;
  const scale = 1 / Math.sqrt(norm);
  return vector.map((value) => value * scale);
}

export function checkLexicalDim(dim: number): string | null {
  if (!Number.isInteger(dim) || dim < LEXICAL_MIN_DIM || dim > LEXICAL_MAX_DIM) {
    return `${LEXICAL_MODEL} takes an embedding.dim from ${LEXICAL_MIN_DIM} to ${LEXICAL_MAX_DIM}; ${dim} is outside it.`;
  }
  return null;
}

export function createLexicalEmbedder(dim: number = LEXICAL_DEFAULT_DIM): (texts: string[]) => Promise<number[][]> {
  const problem = checkLexicalDim(dim);
  if (problem) throw new Error(problem);
  return async (texts) => texts.map((text) => lexicalVector(text, dim));
}
