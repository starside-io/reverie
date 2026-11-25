import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registry } from "../../src/tools/index.js";
import type { GetResult } from "../../src/tools/read/get.js";
import type { TestHost } from "../test-host.js";
import { gateHost, runEveryTool } from "./harness.js";

/**
 * Gate: works without Fellowship. Every tool behaves with the people module
 * absent, and references render as unavailable.
 *
 * The test host's refs port answers `unavailable` for every URI, which is
 * what a host with no people module gives, and the optional ports (models,
 * connectors, privacy) are absent. Every one of the 41 tools is called with
 * input that should succeed, and none throws for want of the people module.
 */

describe("with the people module absent and no optional port", () => {
  let host: TestHost;

  beforeEach(async () => {
    host = await gateHost();
    expect(host.ports.models).toBeUndefined();
    expect(host.ports.connectors).toBeUndefined();
    expect(host.ports.privacy).toBeUndefined();
    expect(await host.ports.refs.resolve("module://people/person/p_sam")).toMatchObject({ status: "unavailable" });
  });
  afterEach(async () => {
    await host.close();
  });

  it("every one of the 41 tools answers", async () => {
    const { called } = await runEveryTool(host);
    expect([...new Set(called)].sort()).toEqual(registry.names().sort());
    expect(registry.names()).toHaveLength(41);
  });

  it("a reference to a person renders as unavailable, keeping its label, and a plain name as unresolved", async () => {
    const { calls } = await runEveryTool(host);
    const got = await host.invoke<GetResult>("memory.get", { call: calls.christmas });
    expect(got.memory.attendees).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ uri: "module://people/person/p_sam", status: "unavailable" }),
        expect.objectContaining({ uri: null, label: "Jane Doe", status: "unresolved" }),
      ]),
    );
    expect(got.memory.occasion).toMatchObject({ uri: "module://people/event/e_8812", label: "Christmas at home", status: "unavailable" });
  });
});
