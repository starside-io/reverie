import { z } from "zod";

import { CALL_NUMBER_PATTERN } from "../../domain/catalogue/call-number.js";

/**
 * Input pieces more than one tool takes. Kept here so two tools never spell
 * the same field two ways.
 */

/** A full call number, current or alias: `LIF/GTH/2026-12-24/001`. */
export const callSchema = z
  .string()
  .trim()
  .regex(CALL_NUMBER_PATTERN, "Expected a call number such as LIF/GTH/2026-12-24/001");

/**
 * The yes on every needs-ok tool (guardrail 1). A z.literal(true), so the flag
 * is part of validation and a handler cannot forget to check it: a call
 * without it never reaches the body. It is the caller's statement that the
 * owner saw this exact content and said yes, and an assistant that sets it on
 * its own judgement is lying to the owner, not to this file.
 */
export const confirmedByUser = z.literal(true, {
  errorMap: () => ({
    message:
      "confirmedByUser must be true. Show the owner exactly what this will change and get an explicit yes first.",
  }),
});
