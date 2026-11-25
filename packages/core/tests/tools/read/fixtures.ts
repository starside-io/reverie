import { createMemory } from "../../../src/domain/memories.js";
import type { MemoryCreateInput } from "../../../src/schemas/memory.js";
import type { TestHost } from "../../test-host.js";

/**
 * Shared set-up for the read tool tests. Memories are written through the
 * domain, not the write tools, so these tests stand on their own while the
 * write tools are being built. Every name is invented.
 */

export const NOW = new Date("2026-12-27T10:00:00.000Z");

export function stated(quote: string) {
  return [
    {
      source: { kind: "conversation" as const, label: "session of 2026-12-27", trust: "stated" as const },
      quote,
    },
  ];
}

export function external(quote: string) {
  return [
    {
      source: { kind: "page" as const, label: "a page", uri: "https://example.test/page", trust: "external" as const },
      quote,
    },
  ];
}

/** One memory, active, stated, written and confirmed at `at` (NOW by default). */
export async function seed(host: TestHost, overrides: Partial<MemoryCreateInput> = {}, at?: Date) {
  const body = overrides.body ?? "Hosted Christmas. The oven died mid afternoon, so we ordered pizza.";
  return createMemory(
    host.db,
    {
      shelf: "LIF/GTH",
      occurredOn: "2026-12-24",
      kind: "episode",
      title: "Christmas at home",
      body,
      trust: "stated",
      sources: stated(body.slice(0, 100)),
      ...overrides,
    },
    { actor: "user", at: at ?? host.now ?? NOW },
  );
}

/** A project row in the silo, the way set_projects would leave it. */
export async function project(host: TestHost, slug: string, options: { repoUrl?: string; shelf?: string; tag?: string } = {}) {
  let shelfId: string | undefined;
  if (options.shelf) {
    const [section, code] = options.shelf.split("/") as [string, string];
    const shelf = await host.db.shelf.findFirstOrThrow({ where: { code, section: { code: section } } });
    shelfId = shelf.id;
  }
  let tagId: string | undefined;
  if (options.tag) {
    const tag = await host.db.tag.upsert({
      where: { slug: options.tag },
      create: { slug: options.tag, colour: "#6366f1" },
      update: {},
    });
    tagId = tag.id;
  }
  return host.db.project.create({
    data: {
      slug,
      name: slug.charAt(0).toUpperCase() + slug.slice(1),
      ...(options.repoUrl ? { repoUrl: options.repoUrl } : {}),
      ...(shelfId ? { shelfId } : {}),
      ...(tagId ? { tagId } : {}),
    },
  });
}
