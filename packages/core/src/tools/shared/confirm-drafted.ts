import { worseTrust, type TrustTier } from "../../schemas/enums.js";
import type { SourceCreateInput } from "../../schemas/source.js";
import { ToolError } from "../registry.js";
import type { DraftEnvelope } from "./confirm-proposals.js";

/**
 * What a drafted memory lands with: the trust a draft earns and the material
 * it was drafted from as its source. docs/SPEC.md section 4 ("confirmed:
 * drafted by a model, confirmed in review"; external never yields a
 * procedure and never enters the core block), section 15 (decide),
 * guardrail 2.
 *
 * memory.decide builds one, from the draft envelope propose_draft put in
 * the proposal, and hands it to a write tool's commit function as its last
 * argument; memory.import builds one for each file it reads from a folder,
 * from the file itself. No tool input carries it, so a caller of memory.remember (or
 * update, supersede, add_source) can never set the trust of a memory or of
 * its source: the direct door stays `stated`, citing the owner's own words.
 */
export interface DraftedProvenance {
  /**
   * `confirmed`, or `external` when anything about the material was external.
   * `stated` only from a folder import: a note the owner wrote by hand in
   * their own mirror folder, imported with their yes.
   */
  trust: "stated" | "confirmed" | "external";
  /** The trust discipline runs at: the least trusted of what the envelope says. */
  sourceTrust: TrustTier;
  /** The drafted quote, citing the material. The quote is its provenance. */
  citation: { source: SourceCreateInput; quote: string };
  /** The door `memory.memory.written` names: `import` for a folder import. Review otherwise. */
  door?: "import";
}

/**
 * The provenance a drafted proposal carries, or a refusal when it carries no
 * source and quote: no source, no memory. Trust is derived, never copied
 * from the envelope alone: external material lands external.
 */
export function draftedProvenance(draft: DraftEnvelope): DraftedProvenance {
  if (!draft.source || !draft.quote) {
    throw new ToolError(
      "refused",
      "No source, no memory: a drafted proposal names the material it was drafted from and the quote it found there, and this one names none. Nothing was written.",
    );
  }
  let sourceTrust: TrustTier = draft.source.trust;
  if (draft.sourceTrust) sourceTrust = worseTrust(sourceTrust, draft.sourceTrust);
  if (draft.trust === "external") sourceTrust = "external";
  const { occurredAt, uri, ...rest } = draft.source;
  return {
    trust: sourceTrust === "external" ? "external" : "confirmed",
    sourceTrust,
    citation: {
      source: { ...rest, ...(uri ? { uri } : {}), ...(occurredAt ? { occurredAt } : {}), trust: draft.source.trust },
      quote: draft.quote,
    },
  };
}
