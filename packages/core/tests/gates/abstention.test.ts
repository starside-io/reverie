import { afterEach, describe, expect, it } from "vitest";

import type { RecallResult } from "../../src/tools/read/recall.js";
import type { TestHost } from "../test-host.js";
import { candidate, extractAndConfirm, file, gateHost, remember } from "./harness.js";

/**
 * Gate: abstention. With no memory above the floor, recall returns
 * `sufficient: false` and zero items, and nothing else: it never pads the
 * result from below the floor.
 */

describe("abstention", () => {
  let host: TestHost;
  afterEach(async () => {
    await host.close();
  });

  const recall = (query: string) => host.invoke<RecallResult>("memory.recall", { query });

  it("an empty library abstains", async () => {
    host = await gateHost();
    expect(await recall("christmas")).toEqual({ items: [], sufficient: false });
  });

  it("a query nothing matches abstains, however full the library", async () => {
    host = await gateHost();
    await remember(host, { shelf: "LIF/HOM", body: "Prefers oat milk in coffee." });
    await remember(host, { shelf: "LIF/GTH", kind: "episode", body: "Hosted Christmas with Jane Doe." });
    expect(await recall("submarine telescope")).toEqual({ items: [], sufficient: false });
  });

  it("matches that score under the floor are dropped, not padded in", async () => {
    host = await gateHost({ config: { recall: { floor: 0.5 } } });
    // External trust weighs 0.3, so even a perfect match scores under 0.5.
    await extractAndConfirm(
      host,
      file("The office closes at six on Fridays."),
      candidate({ title: "Office", body: "The office closes at six on Fridays.", quote: "The office closes at six on Fridays." }),
    );
    expect(await recall("office closes Fridays")).toEqual({ items: [], sufficient: false });
    // The same library with the floor lowered finds it, so the abstention above was the floor's.
    host.config = { ...host.config, recall: { ...host.config.recall, floor: 0.05 } };
    expect((await recall("office closes Fridays")).items).toHaveLength(1);
  });

  it("a retired or superseded entry never pads an abstention", async () => {
    host = await gateHost();
    const old = await remember(host, { shelf: "LIF/HOM", body: "Keeps the ladder in the garage.", occurredOn: "2026-01-10" });
    await host.invoke("memory.retire", { call: old.memory.call });
    expect(await recall("ladder garage")).toEqual({ items: [], sufficient: false });
  });
});
