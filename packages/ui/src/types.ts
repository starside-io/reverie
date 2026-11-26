/**
 * The shapes the screens read, as the tools in packages/core/src/tools return
 * them. Written out by hand rather than imported: this package imports nothing
 * from core (docs/SPEC.md section 21), so these mirror the tool results and a
 * test against a real host (packages/mini-host/tests/e2e-ui.test.ts) keeps
 * them honest.
 */

export type MemoryKind = "fact" | "preference" | "procedure" | "episode" | "reference";
export type TrustTier = "stated" | "confirmed" | "inferred" | "external";
export type MemoryState = "active" | "superseded" | "retired";
export type MemoryScope = "global" | "project" | "agent" | "session";

export const KINDS: readonly MemoryKind[] = ["fact", "preference", "procedure", "episode", "reference"];

/** memory.shelves */
export interface ShelfEntry {
  code: string;
  path: string;
  name: string;
  description: string;
  order: number;
  count: number;
  total: number;
}

export interface SectionEntry {
  code: string;
  name: string;
  order: number;
  count: number;
  total: number;
  shelves: ShelfEntry[];
}

export interface ShelvesResult {
  sections: SectionEntry[];
}

/** The compact entry of browse, about, search and stale. */
export interface EntryView {
  id: string;
  call: string;
  shelf: string;
  occurredOn: string;
  kind: MemoryKind;
  state: MemoryState;
  trust: TrustTier;
  scope: MemoryScope;
  scopeRef: string | null;
  title: string;
  excerpt: string;
  tags: string[];
  pinned: boolean;
  lastConfirmedAt: string;
}

/** memory.browse */
export interface BrowseResult {
  notice: string;
  order: "asc" | "desc";
  items: EntryView[];
  nextCursor: string | null;
  anchor: string | null;
}

export interface RenderedRef {
  role: "attendee" | "occasion" | "mentions";
  uri: string | null;
  label: string;
  status: "resolved" | "unavailable" | "unresolved";
}

/** One whole memory, as get, update, shelve and retire return it. */
export interface MemoryView {
  id: string;
  call: string;
  shelf: string;
  occurredOn: string;
  seq: number;
  kind: MemoryKind;
  scope: MemoryScope;
  scopeRef: string | null;
  title: string;
  body: string;
  why: string | null;
  howToApply: string | null;
  importance: number;
  trust: TrustTier;
  state: MemoryState;
  validFrom: string;
  validTo: string | null;
  supersededBy: string | null;
  pinned: boolean;
  lastConfirmedAt: string;
  createdAt: string;
  tags: string[];
  attendees: RenderedRef[];
  occasion: RenderedRef | null;
  mentions: RenderedRef[];
  sources: Array<{
    sourceId: string;
    kind: string;
    label: string;
    uri: string | null;
    trust: TrustTier;
    quote: string;
  }>;
  aliases: string[];
}

/** memory.get */
export interface GetResult {
  notice: string;
  moved: boolean;
  memory: MemoryView;
}

/** memory.sources */
export interface SourcesResult {
  memoryId: string;
  call: string;
  sources: Array<{
    sourceId: string;
    kind: string;
    label: string;
    uri: string | null;
    trust: TrustTier;
    occurredAt: string | null;
    createdAt: string;
    quote: string;
    citedBy: number;
  }>;
}

export interface VersionView {
  id: string;
  operation: string;
  actor: string;
  at: string;
  contentSha256: string | null;
  redacted: boolean;
  content: {
    callNumber: string;
    shelf: string;
    occurredOn: string;
    title: string;
    body: string;
    importance: number;
    trust: string;
    state: string;
    tags: string[];
  } | null;
}

/** memory.history, without asOf */
export interface HistoryResult {
  mode: "history";
  memoryId: string;
  call: string;
  versions: VersionView[];
  absorbed: Array<{ memoryId: string; call: string; versions: VersionView[] }>;
}

/** memory.related */
export interface RelatedResult {
  call: string;
  memoryId: string;
  items: Array<{
    id: string;
    call: string;
    title: string;
    state: MemoryState;
    sharedTags: string[];
    sharedPeople: string[];
    sharedOccasion: boolean;
    score: number;
    reason: string;
  }>;
}

/** memory.tags */
export interface TagsResult {
  tags: Array<{ slug: string; colour: string; count: number }>;
}

/** memory.recall */
export interface FramedItem {
  call: string;
  kind: MemoryKind;
  body: string;
  tags: string[];
  attendees: string[];
  occasion: string | null;
  trust: TrustTier;
  ageDays: number;
  source: { kind: string; label: string };
  score: number;
  id: string;
}

export type RecallResult =
  | {
      sufficient: true;
      notice: string;
      items: FramedItem[];
      retrieval: { vectors: boolean; ftsOnlyReason?: string; missingEmbeddings?: number };
      recallId: string | null;
    }
  | { items: []; sufficient: false };

/** memory.explain with a call and a recallId */
export interface ExplainResult {
  call: string | null;
  memoryId: string | null;
  weights: {
    kind: MemoryKind;
    importance: number;
    importanceFactor: number;
    trust: TrustTier;
    trustWeight: number;
    lastConfirmedAt: string;
    recency: number;
    halfLifeDays: number | null;
  } | null;
  recalls: Array<{
    recallId: string;
    at: string;
    items: Array<{ rank: number; memoryId: string; call: string | null; score: number }>;
    match: { rank: number; score: number } | null;
  }>;
}

export interface ProposalGroup {
  id: string;
  title: string;
  detail?: string;
  meta?: Record<string, unknown>;
}

/** memory.review */
export interface ReviewItem {
  id: string;
  tool: string;
  payload: unknown;
  summary: string | null;
  memoryId: string | null;
  call: string | null;
  group: ProposalGroup | null;
  state: "pending" | "confirmed" | "discarded";
  createdAt: string;
  decidedAt: string | null;
}

export interface ReviewStep {
  step: number;
  part: "occasion" | "memory" | "note";
  proposalId: string;
  noteIndex?: number;
  tool: string;
  summary: string;
}

export interface FrontDeskLink {
  occasionPending: Array<{
    call: string;
    title: string;
    occurredOn: string;
    occasion: { title: string; type: string; occurredAt: string };
    followUp: unknown;
  }>;
  occasionsWithNoStory: Array<{
    occasion: string;
    title: string | null;
    occurredOn: string | null;
    people: string[];
    loggedAt: string;
  }>;
  unresolvedNames: Array<{ name: string; calls: string[] }>;
  notice: string | null;
}

export interface ReviewResult {
  state: string;
  proposals: ReviewItem[];
  groups: Array<{ id: string; title: string; detail: string | null; steps: ReviewStep[] }>;
  frontDesk: FrontDeskLink;
}

/** memory.stale */
export interface StaleResult {
  staleAfterDays: number;
  cutoff: string;
  items: Array<EntryView & { daysSinceConfirmed: number }>;
  total: number;
}

/** memory.conflicts */
export interface ConflictsResult {
  pairs: Array<{
    linkId: string;
    createdAt: string;
    from: { memoryId: string; call: string; title: string; state: MemoryState };
    to: { memoryId: string; call: string; title: string; state: MemoryState };
  }>;
  total: number;
}

/** memory.about */
export interface AboutResult {
  items: Array<EntryView & { role: string; matchedBy: "uri" | "label" }>;
  total: number;
}

/** memory.remember */
export interface RememberResult {
  memory: MemoryView;
  landedOnReturns: boolean;
  notice: string | null;
  unresolved: string[];
}

/** memory.shelve, action move */
export interface ShelveMoveResult {
  action: "move";
  memory: MemoryView;
  from: string;
  to: string;
}

/** memory.forget */
export interface ForgetResult {
  forgotten: { memoryId: string; call: string; retiredNumbers: string[] };
  sourcesDeleted: number;
  tagsDeleted: number;
}
