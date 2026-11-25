import { z } from "zod";

/**
 * The four reconcile verbs. docs/SPEC.md section 13. One candidate beside its
 * nearest neighbours gets one verb back.
 */
export const ReconcileVerb = z.enum(["add", "refine", "supersede", "duplicate"]);
export type ReconcileVerb = z.infer<typeof ReconcileVerb>;

/** The memory a verb acts on: an id, or a call number, current or alias. */
export const reconcileTargetSchema = z.string().trim().min(1, "A target is required").max(200);

/** Why the drafter chose the verb, for the review card. Starting value. */
const reasonSchema = z.string().trim().min(1).max(500).optional();

/**
 * One verb back from the reconcile job. `add` names no target; the other three
 * name the existing memory they act on. Strict, so a target on an `add` (or a
 * typo in a field name) is refused rather than ignored.
 */
export const reconcileVerdictSchema = z.discriminatedUnion("verb", [
  z.object({ verb: z.literal("add"), reason: reasonSchema }).strict(),
  z.object({ verb: z.literal("refine"), target: reconcileTargetSchema, reason: reasonSchema }).strict(),
  z.object({ verb: z.literal("supersede"), target: reconcileTargetSchema, reason: reasonSchema }).strict(),
  z.object({ verb: z.literal("duplicate"), target: reconcileTargetSchema, reason: reasonSchema }).strict(),
]);

export type ReconcileVerdictInput = z.input<typeof reconcileVerdictSchema>;
export type ReconcileVerdict = z.output<typeof reconcileVerdictSchema>;
