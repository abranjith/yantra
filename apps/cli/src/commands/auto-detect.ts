/**
 * Tiny utility that distinguishes a run ID from a workflow name for the
 * `yantra show` auto-detect path.
 *
 * Run IDs are produced by {@link formatRunId} (FEAT-010) and always start
 * with an ISO-compact timestamp prefix like `20260516T120304Z-`. Workflow
 * names cannot contain colons or `Z`-suffixed timestamps, so the regex is
 * unambiguous.
 */

const RUN_ID_PATTERN = /^\d{8}T\d{6}Z-/;

export type ShowTarget = 'workflow' | 'run';

export function detectShowTarget(arg: string): ShowTarget {
  return RUN_ID_PATTERN.test(arg) ? 'run' : 'workflow';
}
