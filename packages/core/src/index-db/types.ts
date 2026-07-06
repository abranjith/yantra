/**
 * Shared types and error class for the local SQLite index stores.
 *
 * The stores (`HistoryStore`, `PreferenceStore`, `RateLimitStore`) are
 * repository-like abstractions over `index.db`, mockable in tests — the same
 * pattern as `WorkflowStore`/`RunStore`. All fallible operations return
 * `Result<T, IndexDbError>`; the index must never make a task fail, so callers
 * degrade gracefully on the error branch (plan §6, memory §Error Handling).
 */

/** The task verbs recorded in `history.task_type`. */
export type TaskType = 'ask' | 'research' | 'run' | 'do';

/** Terminal task outcomes recorded in `history.status`. */
export type HistoryStatus = 'succeeded' | 'failed' | 'handoff' | 'aborted';

/**
 * Domain-specific failure for any index store operation. Carries the failing
 * operation and underlying cause per the project's custom-error convention.
 */
export class IndexDbError extends Error {
  public override readonly name = 'IndexDbError';

  public constructor(
    message: string,
    public readonly context: {
      /** The store operation that failed (e.g. `history.record`). */
      readonly op: string;
      /** Underlying cause, when available. */
      readonly cause?: unknown;
    },
  ) {
    super(message);
  }
}
