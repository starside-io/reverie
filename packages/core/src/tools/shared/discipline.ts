import {
  runDiscipline,
  type DisciplineFinding,
  type DisciplineInput,
} from "../../domain/discipline.js";
import { ToolError } from "../registry.js";

/**
 * Discipline on a write (section 7, guardrail 3): the four checks, both doors.
 * Throws a `refused` ToolError naming every finding when any check fails, and
 * returns nothing when all pass.
 */
export function enforceDiscipline(input: DisciplineInput): void {
  const verdict = runDiscipline(input);
  if (!verdict.ok) refuseFindings(verdict.findings);
}

/**
 * The refusal for a set of findings, for a caller that ran a single check
 * itself (a quote gets the secret scan only). The detail carries each
 * finding's check, code, label, field and reason, never a matched secret: the
 * domain keeps a secret out of its findings and this never adds one back.
 */
export function refuseFindings(findings: readonly DisciplineFinding[]): void {
  if (findings.length === 0) return;
  const shown = findings.map((finding) => ({
    check: finding.check,
    code: finding.code,
    label: finding.label,
    ...(finding.field ? { field: finding.field } : {}),
    reason: finding.reason,
  }));
  const reasons = shown.map((finding) => finding.reason).join(" ");
  throw new ToolError("refused", `Not written. ${reasons}`, { findings: shown });
}
