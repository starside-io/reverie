import { reshelveMemory, createShelf } from "../../src/domain/catalogue/shelving.js";
import { attachTags, renameTag } from "../../src/domain/catalogue/tags.js";
import {
  addSource,
  createMemory,
  pinMemory,
  retireMemory,
  supersedeMemory,
  touchMemory,
} from "../../src/domain/memories.js";
import { applyVerdict } from "../../src/domain/reconcile.js";
import { forgetMemory, redactMemory } from "../../src/domain/versions.js";
import type { ExportSnapshot } from "../../src/domain/transfer/snapshot.js";
import { openSilo, type Silo } from "../../src/storage/client.js";
import { episode, openLibrary } from "../domain/library.js";
import { freshSiloPath } from "../storage/throwaway.js";

/** A migrated silo with nothing in it, not even the starting library. */
export async function emptySilo(): Promise<Silo> {
  return openSilo({ path: freshSiloPath() });
}

/** The whole file bar the timestamp of the export itself. */
export function comparable(snapshot: ExportSnapshot): Omit<ExportSnapshot, "exportedAt"> {
  const { exportedAt: _ignored, ...rest } = snapshot;
  return rest;
}

const at = (iso: string) => ({ actor: "user", at: new Date(iso) });

export interface RichLibrary {
  db: Silo;
  christmas: string;
  editor: string;
  editorNow: string;
  forgotten: string;
  forgottenNumber: string;
  retired: string;
}

/**
 * Every kind of row the snapshot carries: a custom shelf, a project with a
 * repository, tags (one renamed), resolved and unresolved refs, sources with
 * a uri and a time, a refine, a supersede, a reshelve (an alias), a redaction,
 * a forget (a null alias and redacted versions), a retired entry, a pin,
 * links, recall counters, and the rows a snapshot leaves out: an embedding, a
 * session note and a recall log. Every name is invented.
 */
export async function richLibrary(): Promise<RichLibrary> {
  const db = await openLibrary();

  const shelf = await createShelf(db, {
    section: "WRK",
    code: "RVR",
    name: "Reverie",
    description: "Reverie, the memory library: design and decisions.",
  });
  const tag = await db.tag.create({ data: { slug: "reverie", colour: "#5b82a6" } });
  await db.project.create({
    data: {
      slug: "reverie",
      name: "Reverie",
      repoUrl: "github.com/jane-doe/reverie",
      shelfId: shelf.id,
      tagId: tag.id,
      description: "The memory library.",
    },
  });

  const christmas = await createMemory(
    db,
    episode({
      tags: ["christmas", "family"],
      refs: [
        { role: "attendee", label: "Jane Doe", uri: "module://people/person/jane" },
        { role: "attendee", label: "Sam Rivera" },
        { role: "occasion", label: "Christmas 2026", uri: "module://people/event/xmas-2026" },
      ],
      body: "Hosted Christmas with Jane Doe, John Doe and Sam Rivera. Café au lait \"quotes\" and a\nsecond line #holiday.",
      importance: 4,
    }),
    at("2026-12-27T10:00:00Z"),
  );
  await addSource(
    db,
    christmas,
    {
      source: {
        kind: "page",
        uri: "https://example.test/photos/xmas",
        label: "Photo album",
        occurredAt: "2026-12-24T19:30:00Z",
        trust: "external",
      },
      quote: "Christmas Eve, everyone at the table",
    },
    at("2026-12-28T10:00:00Z"),
  );
  await pinMemory(db, christmas, true, at("2026-12-28T11:00:00Z"));
  await reshelveMemory(db, christmas, { occurredOn: "2026-12-25" }, at("2026-12-29T09:00:00Z"));

  const editor = await createMemory(
    db,
    {
      shelf: "WRK/RVR",
      occurredOn: "2026-11-02",
      kind: "procedure",
      scope: "project",
      scopeRef: "reverie",
      title: "Commit style",
      body: "Write commit subjects in the imperative. #reverie",
      why: "The log reads as a list of changes.",
      howToApply: "Before every commit.",
      trust: "stated",
      sources: [{ source: { kind: "conversation", label: "session of 2026-11-02", trust: "stated" }, quote: "imperative subjects" }],
    },
    at("2026-11-02T10:00:00Z"),
  );
  await applyVerdict(
    db,
    { verb: "refine", target: editor.id },
    {
      shelf: "WRK/RVR",
      occurredOn: "2026-11-02",
      kind: "procedure",
      scope: "project",
      scopeRef: "reverie",
      title: "Commit style",
      body: "Write commit subjects in the imperative, under fifty characters. #reverie",
      trust: "stated",
      sources: [{ source: { kind: "conversation", label: "session of 2026-11-20", trust: "stated" }, quote: "under fifty" }],
    },
    at("2026-11-20T10:00:00Z"),
  );
  const superseded = await supersedeMemory(
    db,
    editor,
    {
      shelf: "WRK/RVR",
      occurredOn: "2026-12-01",
      kind: "procedure",
      scope: "project",
      scopeRef: "reverie",
      title: "Commit style",
      body: "Write commit subjects in the imperative, under seventy two characters.",
      trust: "stated",
      sources: [{ source: { kind: "conversation", label: "session of 2026-12-01", trust: "stated" }, quote: "seventy two" }],
    },
    at("2026-12-01T10:00:00Z"),
  );
  await redactMemory(db, superseded.old.id, at("2026-12-02T10:00:00Z"));

  const forgotten = await createMemory(
    db,
    episode({ title: "Dentist", body: "Saw the dentist about a cracked molar.", shelf: "LIF/HLT", occurredOn: "2026-10-10" }),
    at("2026-10-10T10:00:00Z"),
  );
  const forgottenNumber = forgotten.callNumber;

  const retired = await createMemory(
    db,
    {
      shelf: "REF/LNK",
      occurredOn: "2026-09-01",
      kind: "reference",
      title: "Old dashboard",
      body: "The build dashboard lived at example.test/builds.",
      trust: "stated",
      sources: [{ source: { kind: "file", uri: "file-ref:notes.md", label: "notes", trust: "stated" }, quote: "builds dashboard" }],
    },
    at("2026-09-01T10:00:00Z"),
  );
  await retireMemory(db, retired, at("2026-12-03T10:00:00Z"));
  await touchMemory(db, superseded.replacement, { at: new Date("2026-12-10T10:00:00Z") });
  await attachTags(db, superseded.replacement.id, ["git"], at("2026-12-11T10:00:00Z"));
  await renameTag(db, "family", "household");

  await db.memoryLink.create({ data: { fromId: christmas.id, toId: superseded.replacement.id, relation: "elaborates" } });
  await db.memoryLink.create({ data: { fromId: christmas.id, toId: forgotten.id, relation: "contradicts" } });
  await db.memory.update({
    where: { id: christmas.id },
    data: { recallCount: 3, lastRecalledAt: new Date("2027-01-02T08:00:00Z") },
  });

  // Rows the snapshot leaves out.
  await db.embedding.create({
    data: { memoryId: christmas.id, model: "test-embed", dim: 2, vector: Buffer.from(new Float32Array([0.5, 0.25]).buffer) },
  });
  await db.sessionNote.create({
    data: { sessionId: "s-1", body: "scratch about Sam Rivera", expiresAt: new Date("2027-01-04T00:00:00Z") },
  });
  await db.recallLog.create({ data: { scope: "global", memoryIds: [christmas.id], scores: [0.9], budget: 1200 } });

  await forgetMemory(db, forgotten, at("2026-12-20T10:00:00Z"));

  return {
    db,
    christmas: christmas.id,
    editor: editor.id,
    editorNow: superseded.replacement.id,
    forgotten: forgotten.id,
    forgottenNumber,
    retired: retired.id,
  };
}
