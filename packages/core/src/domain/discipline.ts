import type { MemoryKind, TrustTier } from "../schemas/enums.js";

/**
 * Discipline at write: the four checks every write path runs, both doors,
 * before anything lands. docs/SPEC.md section 7, gates in section 16.
 *
 * Pure. Input is a plain object, not a database row, and each check returns a
 * structured result: a machine code to branch on and a human reason to show.
 * A finding never carries a matched secret back out, so a refusal can be
 * logged or shown without leaking what it refused.
 *
 * Every pattern list below is a starting value, tuned against fixtures rather
 * than a corpus. Each errs toward refusing: a write that is refused can be
 * reworded, a secret that lands has to be forgotten.
 */

export interface DisciplineInput {
  kind: MemoryKind;
  title: string;
  body: string;
  why?: string | null;
  howToApply?: string | null;
  /** Trust of the source the content came from. */
  sourceTrust: TrustTier;
  /** True only when the owner explicitly asked for this to be remembered. */
  explicitAsk?: boolean;
}

export type DisciplineField = "title" | "body" | "why" | "howToApply";

export type DisciplineCheckName = "secret" | "instruction" | "relativeDate" | "sensitive";

export type DisciplineCode =
  | "secret-detected"
  | "instruction-shaped"
  | "external-procedure"
  | "relative-date"
  | "sensitive-category";

export type SensitiveCategory = "health" | "money" | "politics" | "religion" | "sexuality";

export interface DisciplineFinding {
  check: DisciplineCheckName;
  code: DisciplineCode;
  /** One sentence for a person, naming what was found and what to do. */
  reason: string;
  /** Which field it was found in; absent for a rule about the whole input. */
  field?: DisciplineField;
  /**
   * The text that matched, as written. Never set for a secret: a secret is
   * named by `label` alone.
   */
  match?: string;
  /** What kind of thing matched: "AWS access key id", "health", a rule name. */
  label: string;
}

export interface CheckResult {
  check: DisciplineCheckName;
  ok: boolean;
  findings: DisciplineFinding[];
}

export interface DisciplineResult {
  ok: boolean;
  /** Every finding from every check, in check order. */
  findings: DisciplineFinding[];
  /** One result per check, in the order section 7 lists them. */
  checks: CheckResult[];
}

const ALL_FIELDS: readonly DisciplineField[] = ["title", "body", "why", "howToApply"];

function fieldsOf(input: DisciplineInput, which: readonly DisciplineField[] = ALL_FIELDS) {
  const out: Array<[DisciplineField, string]> = [];
  for (const field of which) {
    const value = input[field];
    if (typeof value === "string" && value.length > 0) out.push([field, value]);
  }
  return out;
}

function result(check: DisciplineCheckName, findings: DisciplineFinding[]): CheckResult {
  return { check, ok: findings.length === 0, findings };
}

/** A fresh global copy, so lastIndex state never leaks between calls. */
function globalCopy(pattern: RegExp): RegExp {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  return new RegExp(pattern.source, flags);
}

// ---------------------------------------------------------------------------
// Secret scan
// ---------------------------------------------------------------------------

interface SecretRule {
  label: string;
  pattern: RegExp;
}

/**
 * Shapes of keys and tokens. Starting value. Order matters only for which
 * label wins when two rules match the same span: the specific one first.
 */
const SECRET_RULES: readonly SecretRule[] = [
  { label: "private key block", pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/ },
  { label: "AWS access key id", pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/ },
  {
    label: "AWS secret access key",
    pattern: /\baws_?secret_?access_?key\b["']?\s*[:=]\s*["']?[A-Za-z0-9/+]{40}/i,
  },
  { label: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { label: "GitHub fine grained token", pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/ },
  { label: "Stripe secret key", pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/ },
  { label: "Stripe webhook secret", pattern: /\bwhsec_[A-Za-z0-9]{24,}\b/ },
  { label: "Slack token", pattern: /\bxox[abeposr]-[A-Za-z0-9-]{10,}\b/ },
  {
    label: "Slack webhook URL",
    pattern: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/,
  },
  // A digit is required so a long hyphenated slug starting "sk-" is not a key.
  { label: "Anthropic API key", pattern: /\bsk-ant-(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{20,}/ },
  {
    label: "OpenAI API key",
    pattern: /\bsk-(?:proj-|svcacct-|admin-)?(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{20,}/,
  },
  { label: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  {
    label: "JSON web token",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  },
  // A bearer token: at least 20 token characters with a digit among them, so
  // "the bearer of bad news" stays a sentence.
  { label: "bearer token", pattern: /\bbearer\s+(?=[A-Za-z0-9._~+/-]*\d)[A-Za-z0-9._~+/-]{20,}=*/i },
  { label: "credentials in a URL", pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s:/@]+@[^\s/]+/i },
];

/**
 * `password: hunter2`, `passwd=...`, `api_key = "..."`. The keyword must be
 * followed directly by the separator, so "my password policy: rotate" passes.
 * Starting value.
 */
const ASSIGNMENT_PATTERNS: readonly RegExp[] = [
  /\b(?:password|passwd|passphrase|client[_-]?secret|secret[_-]?key|api[_-]?key|(?:auth|access|refresh|bearer|api)[_-]?token|private[_-]?key)\b["']?\s*[:=]\s*["']?(<[^>]*>|[^\s"',;]+)/gi,
  // "my password is hunter2": the spoken form, for the password words only.
  /\b(?:password|passwd|passphrase)\s+is\s+["']?(<[^>]*>|[^\s"',;]+)/gi,
];

/** Values that stand for a secret without being one. Starting value. */
const PLACEHOLDER_VALUE =
  /^(?:<[^>]*>|\*+|x{3,}|\.{3,}|\$\{[^}]*\}|\{\{[^}]*\}\}|\$[A-Z_][A-Z0-9_]*|\[?redacted\]?|hidden|none|null|empty|unset|required|optional|stored|kept|saved|managed|changed|reset|rotated|see|in|on|from|via)$/i;

/** Minimum length of a run of token characters that is weighed for entropy. Starting value. */
export const ENTROPY_MIN_LENGTH = 32;
/** Shannon entropy, in bits per character, at or above which a run is refused. Starting value. */
export const ENTROPY_MIN_BITS = 4.0;

/** Shannon entropy of a string, in bits per character. */
export function shannonEntropy(text: string): number {
  if (text.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

const HEX_ONLY = /^[0-9a-f]+$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A long run that looks random: long enough, mixed upper, lower and digits,
 * and dense in information. A git SHA or a sha256 is hex and a UUID is hex in
 * groups; neither is refused on its own. A URL or a path is skipped, since its
 * slashes make long runs of ordinary words.
 */
function looksHighEntropy(run: string): boolean {
  if (run.length < ENTROPY_MIN_LENGTH) return false;
  if (HEX_ONLY.test(run) || UUID.test(run)) return false;
  const upper = (run.match(/[A-Z]/g) ?? []).length;
  const lower = (run.match(/[a-z]/g) ?? []).length;
  const digits = (run.match(/[0-9]/g) ?? []).length;
  if (upper < 2 || lower < 2 || digits < 2) return false;
  return shannonEntropy(run) >= ENTROPY_MIN_BITS;
}

function highEntropyRuns(text: string): number {
  let found = 0;
  for (const word of text.split(/\s+/)) {
    if (word.includes("://") || word.startsWith("/") || word.startsWith("~")) continue;
    for (const run of word.match(/[A-Za-z0-9+/=_-]+/g) ?? []) {
      if (looksHighEntropy(run.replace(/=+$/, ""))) found += 1;
    }
  }
  return found;
}

function secretFinding(field: DisciplineField, label: string): DisciplineFinding {
  return {
    check: "secret",
    code: "secret-detected",
    field,
    label,
    reason: `The ${field} holds what looks like a ${label}. Secrets are never stored: remove it, or describe where it lives instead.`,
  };
}

/** Keys, tokens, private keys and passwords. */
export function checkSecrets(input: DisciplineInput): CheckResult {
  const findings: DisciplineFinding[] = [];
  for (const [field, text] of fieldsOf(input)) {
    const labels = new Set<string>();
    // Spans already claimed, so "sk-ant-..." is not also an OpenAI key.
    const claimed: Array<[number, number]> = [];
    const overlaps = (start: number, end: number) => claimed.some(([s, e]) => start < e && end > s);

    for (const rule of SECRET_RULES) {
      for (const match of text.matchAll(globalCopy(rule.pattern))) {
        const start = match.index;
        const end = start + match[0].length;
        if (overlaps(start, end)) continue;
        claimed.push([start, end]);
        labels.add(rule.label);
      }
    }

    for (const pattern of ASSIGNMENT_PATTERNS) {
      for (const match of text.matchAll(globalCopy(pattern))) {
        const start = match.index;
        if (overlaps(start, start + match[0].length)) continue;
        const value = match[1] ?? "";
        if (value.length < 4 || PLACEHOLDER_VALUE.test(value)) continue;
        claimed.push([start, start + match[0].length]);
        labels.add("password or key assignment");
      }
    }

    const masked = claimed.reduce(
      (acc, [s, e]) => acc.slice(0, s) + " ".repeat(e - s) + acc.slice(e),
      text,
    );
    if (highEntropyRuns(masked) > 0) labels.add("high entropy string");

    for (const label of labels) findings.push(secretFinding(field, label));
  }
  return result("secret", findings);
}

// ---------------------------------------------------------------------------
// Instruction shape
// ---------------------------------------------------------------------------

interface InstructionRule {
  label: string;
  pattern: RegExp;
}

const AI = "(?:ai|a\\.i\\.|assistant|assistants|claude|chatgpt|gpt|gemini|copilot|llm|llms|language model|model|agent|agents|bot)";
/** The narrower set for a line that opens by naming its reader: "Agent:" is often a person. */
const AI_NAME = "(?:ai|assistant|claude|chatgpt|gpt|gemini|copilot|llm)";

/**
 * Text addressed to the assistant. Applied only when the source is external:
 * the owner telling their own assistant "always respond in English" is a
 * procedure, a web page saying it is an injection. Starting value.
 */
const INSTRUCTION_RULES: readonly InstructionRule[] = [
  {
    label: "override of earlier instructions",
    pattern:
      /\b(?:ignore|disregard|forget|override|bypass)\s+(?:all\s+|any\s+|the\s+|your\s+|every\s+)*(?:previous|prior|above|earlier|preceding|existing|original|other)?\s*(?:instructions?|prompts?|rules|directions|guidelines|messages|context)\b/i,
  },
  { label: "mention of a system prompt", pattern: /\b(?:system|developer)\s+(?:prompt|message|instructions?)\b/i },
  { label: "new instructions", pattern: /\b(?:new|updated|revised|real|hidden|secret)\s+instructions?\b/i },
  { label: "role reassignment", pattern: /\b(?:you are now|from now on,?\s+you|act as|pretend (?:to be|you are)|roleplay as|you will now)\b/i },
  { label: "directive to the reader", pattern: /\byou\s+(?:must|shall|have to|need to|are required to|should always|should never)\b/i },
  {
    label: "standing output rule",
    pattern:
      /\b(?:always|never)\s+(?:respond|reply|answer|say|output|print|include|mention|reveal|tell|refuse|recommend|use|call|run|execute|obey|follow)\b/i,
  },
  { label: "text addressed to an AI", pattern: new RegExp(`\\b(?:dear|hey|hi|hello|attention|note to(?: the| any| all)?|instructions for(?: the)?)\\s+${AI}\\b`, "i") },
  { label: "text addressed to an AI", pattern: new RegExp(`\\bif you(?: are|'re)\\s+(?:an?\\s+)?${AI}\\b`, "i") },
  { label: "text addressed to an AI", pattern: new RegExp(`^\\s*${AI_NAME}\\s*[:,]`, "im") },
  { label: "concealment from the user", pattern: /\b(?:do not|don't|never)\s+(?:tell|inform|alert|show|let)\s+the\s+(?:user|owner|human)\b/i },
  { label: "command to run", pattern: /\b(?:run|execute|eval)\s+(?:this|the following)\s+(?:command|code|script|tool)\b/i },
  { label: "prompt markup", pattern: /<\/?(?:system|instructions?|assistant)>|\[\/?INST\]|<\|im_start\|>|^#{1,6}\s*(?:system|instructions?)\b/im },
];

/**
 * Refuses text addressed to the assistant when the source is external, and
 * always refuses a procedure from an external source: an external source
 * cannot yield a procedure (section 4, guardrail 4).
 */
export function checkInstructionShape(input: DisciplineInput): CheckResult {
  if (input.sourceTrust !== "external") return result("instruction", []);

  const findings: DisciplineFinding[] = [];
  if (input.kind === "procedure") {
    findings.push({
      check: "instruction",
      code: "external-procedure",
      label: "procedure from an external source",
      reason:
        "A procedure changes how every later session behaves, and an external source can never yield one. Only the owner can state a procedure.",
    });
  }

  for (const [field, text] of fieldsOf(input)) {
    const seen = new Set<string>();
    for (const rule of INSTRUCTION_RULES) {
      const match = text.match(rule.pattern);
      if (!match || seen.has(rule.label)) continue;
      seen.add(rule.label);
      findings.push({
        check: "instruction",
        code: "instruction-shaped",
        field,
        label: rule.label,
        match: match[0].trim(),
        reason: `The ${field} reads as an instruction to the assistant ("${match[0].trim()}"), and it came from an external source. Recalled content is data, never instructions.`,
      });
    }
  }
  return result("instruction", findings);
}

// ---------------------------------------------------------------------------
// Relative dates
// ---------------------------------------------------------------------------

const NUMBER =
  "(?:\\d+|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|a few|a couple(?: of)?|couple of|several|few)";
const UNIT = "(?:minutes?|hours?|days?|nights?|weeks?|fortnights?|months?|years?|decades?)";
const WEEKDAY = "(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekend)";
const PERIOD = "(?:week|month|year|quarter|spring|summer|autumn|fall|winter|semester)";

/**
 * Phrases whose meaning depends on the day they were written. Starting value.
 * "Last/next/this week of ..." is left alone: "the last week of June" names a
 * stretch of a calendar, not a day relative to today.
 */
const RELATIVE_DATE_PATTERNS: readonly RegExp[] = [
  /\b(?:the\s+)?day\s+(?:before\s+yesterday|after\s+tomorrow)\b/i,
  /\b(?:tomorrow night|yesterday|today|tomorrow|tonight|last night)\b/i,
  /\b(?:this|earlier this|later this)\s+(?:morning|afternoon|evening)\b/i,
  /\b(?:earlier|later)\s+today\b/i,
  new RegExp(`\\b(?:last|next|this|coming|past)\\s+${PERIOD}\\b(?!\\s+of\\b)`, "i"),
  new RegExp(`\\b(?:last|next|this|coming|past)\\s+${WEEKDAY}s?\\b`, "i"),
  new RegExp(`\\b(?:earlier|later)\\s+this\\s+${PERIOD}\\b`, "i"),
  new RegExp(`\\b${NUMBER}\\s+${UNIT}\\s+(?:ago|from now|back)\\b`, "i"),
  new RegExp(`\\bin\\s+${NUMBER}\\s+${UNIT}(?:'?\\s*time)?\\b`, "i"),
  new RegExp(`\\b(?:the\\s+)?(?:past|last|next|coming)\\s+${NUMBER}\\s+${UNIT}\\b`, "i"),
  /\bthe other day\b/i,
  /\b(?:a\s+)?(?:week|month|year)\s+ago\b/i,
];

/**
 * Relative dates are checked in the title and the body. `why` and
 * `howToApply` belong to a procedure, where "check today's build" is a
 * standing rule rather than a date. Starting value.
 */
const DATED_FIELDS: readonly DisciplineField[] = ["title", "body"];

/** "Yesterday", "next week", "in 3 weeks": refused with the phrase named. */
export function checkRelativeDates(input: DisciplineInput): CheckResult {
  const findings: DisciplineFinding[] = [];
  for (const [field, text] of fieldsOf(input, DATED_FIELDS)) {
    const phrases: Array<{ index: number; phrase: string }> = [];
    for (const pattern of RELATIVE_DATE_PATTERNS) {
      for (const match of text.matchAll(globalCopy(pattern))) {
        const start = match.index;
        const end = start + match[0].length;
        // Keep the longest phrase at a position: "the day before yesterday", not "yesterday".
        if (phrases.some((p) => start < p.index + p.phrase.length && end > p.index)) {
          const index = phrases.findIndex((p) => start < p.index + p.phrase.length && end > p.index);
          if (match[0].length > phrases[index]!.phrase.length) phrases[index] = { index: start, phrase: match[0] };
          continue;
        }
        phrases.push({ index: start, phrase: match[0] });
      }
    }
    phrases.sort((a, b) => a.index - b.index);
    for (const { phrase } of phrases) {
      findings.push({
        check: "relativeDate",
        code: "relative-date",
        field,
        label: "relative date",
        match: phrase,
        reason: `"${phrase}" in the ${field} is a relative date. Resolve it against the session date and write the date itself, such as 2026-12-24.`,
      });
    }
  }
  return result("relativeDate", findings);
}

// ---------------------------------------------------------------------------
// Sensitive categories
// ---------------------------------------------------------------------------

/**
 * A keyword approach. Starting value: it will both miss and over match, and
 * the cost of an over match is one question to the owner. Words that are
 * mostly used in another sense ("stock", "temple", "campaign", "straight")
 * are left out on purpose.
 */
const SENSITIVE_KEYWORDS: Record<SensitiveCategory, RegExp> = {
  health:
    /\b(?:diagnos(?:is|ed|e)|doctor|physician|hospital|clinic|therap(?:y|ist)|psychiatrist|medication|medicine|prescri(?:ption|bed)|illness|disease|cancer|tumou?r|chemo(?:therapy)?|diabetes|diabetic|asthma|depression|depressed|anxiety disorder|mental health|bipolar|adhd|autis(?:m|tic)|ptsd|pregnan(?:t|cy)|miscarriage|surgery|symptoms?|allerg(?:y|ies|ic)|hiv|migraines?|blood pressure|disability|disabled|rehab|addiction|sobriety|sober)\b/i,
  money:
    /\b(?:salary|salaries|income|paycheck|payslip|wages?|debts?|loans?|mortgage|bank account|credit card|credit score|net worth|savings|invest(?:ed|ing|ment|ments)?|bankrupt(?:cy)?|tax return|owes?|owed|inheritance|pension|401k|crypto(?:currency)?)\b/i,
  politics:
    /\b(?:politics|political|vot(?:e|ed|es|ing|er)|election|elections|ballot|democrats?|republicans?|liberals?|conservatives?|socialists?|communists?|libertarians?|left-wing|right-wing|labour party|labor party|tory|tories|green party|partisan|activist|protest(?:ed|s)?)\b/i,
  religion:
    /\b(?:religion|religious|church|mosque|synagogue|pray(?:s|ed|ing|er|ers)?|faith|atheist|agnostic|christian|muslim|jewish|hindu|buddhist|sikh|catholic|protestant|mormon|bible|quran|koran|torah|ramadan|kosher|halal|sabbath|bapti(?:sm|sed|zed))\b/i,
  sexuality:
    /\b(?:gay|lesbian|bisexual|queer|transgender|trans woman|trans man|non-binary|nonbinary|sexual orientation|sexuality|lgbtq?\+?|asexual|pansexual|coming out|came out|sex life|sexual)\b/i,
};

const SENSITIVE_ORDER: readonly SensitiveCategory[] = ["health", "money", "politics", "religion", "sexuality"];

/** Health, money, politics, religion, sexuality: saved only on an explicit ask. */
export function checkSensitive(input: DisciplineInput): CheckResult {
  if (input.explicitAsk === true) return result("sensitive", []);

  const findings: DisciplineFinding[] = [];
  for (const [field, text] of fieldsOf(input)) {
    for (const category of SENSITIVE_ORDER) {
      const match = text.match(SENSITIVE_KEYWORDS[category]);
      if (!match) continue;
      findings.push({
        check: "sensitive",
        code: "sensitive-category",
        field,
        label: category,
        match: match[0],
        reason: `The ${field} touches ${category} ("${match[0]}"). That is saved only when the owner explicitly asks for it to be remembered.`,
      });
    }
  }
  return result("sensitive", findings);
}

/** Detected sensitive categories, whatever the ask flag says. */
export function sensitiveCategories(input: Omit<DisciplineInput, "explicitAsk">): SensitiveCategory[] {
  const found = checkSensitive({ ...input, explicitAsk: false }).findings.map(
    (finding) => finding.label as SensitiveCategory,
  );
  return SENSITIVE_ORDER.filter((category) => found.includes(category));
}

// ---------------------------------------------------------------------------
// All four
// ---------------------------------------------------------------------------

/** Runs all four checks, in the order section 7 lists them. */
export function runDiscipline(input: DisciplineInput): DisciplineResult {
  const checks = [
    checkSecrets(input),
    checkInstructionShape(input),
    checkRelativeDates(input),
    checkSensitive(input),
  ];
  const findings = checks.flatMap((check) => check.findings);
  return { ok: findings.length === 0, findings, checks };
}
