/**
 * The outcome segment of a `yantra list` run row (FEAT-054, FEAT-064).
 *
 * Dependency-free on purpose: the app's OutcomeBadge parity test imports this
 * exact function (FEAT-066), so the terminal and the app cannot word an
 * outcome differently.
 */

/** The fields of a run row the outcome segment reads. */
export interface ListOutcomeFields {
  readonly status: string;
  readonly taskOutcome?: string | undefined;
  readonly executionState?: 'interrupted' | undefined;
}

/**
 * `status outcome` when the run recorded an outcome, else the status; a run
 * whose owner died reads `interrupted · <outcome>`.
 */
export function listOutcomeSegment(item: ListOutcomeFields): string {
  if (item.executionState === 'interrupted') {
    return `interrupted · ${item.taskOutcome ?? item.status}`;
  }
  return item.taskOutcome === undefined ? item.status : `${item.status} ${item.taskOutcome}`;
}
