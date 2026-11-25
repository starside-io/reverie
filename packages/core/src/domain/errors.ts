import type { ZodError } from "zod";

/**
 * The same codes as a tool error, so a handler maps one onto the other without
 * a table: invalid input, not found, refused by a rule, or in conflict with
 * what is stored.
 */
export type DomainErrorCode = "invalid_input" | "not_found" | "refused" | "conflict";

/** A refusal the caller can act on, as opposed to an unexpected failure. */
export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly detail?: unknown;

  constructor(code: DomainErrorCode, message: string, detail?: unknown) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

/** A failed parse, as a DomainError carrying the zod issues. */
export function invalidInput(error: ZodError): DomainError {
  const message = error.issues
    .map((issue) => (issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message))
    .join("; ");
  return new DomainError("invalid_input", message, error.issues);
}

/** Parse with a schema, throwing a DomainError on failure. */
export function parseInput<T>(
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: ZodError } },
  value: unknown,
): T {
  const result = schema.safeParse(value);
  if (!result.success) throw invalidInput(result.error);
  return result.data;
}
