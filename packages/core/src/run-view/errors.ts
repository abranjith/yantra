/**
 * Typed failures of the run-view reads (FEAT-066). Every error carries safe
 * context only (run id, entry id, code), never file content.
 */

/** Base class of every run-view failure. */
export class RunViewError extends Error {
  public override readonly name: string = 'RunViewError';
}

/** The run directory does not exist. */
export class RunNotFoundError extends RunViewError {
  public override readonly name = 'RunNotFoundError';

  public constructor(public readonly runId: string) {
    super(`Run "${runId}" was not found.`);
  }
}

/** Why a run artifact could not be reached. */
export type ArtifactAccessCode =
  | 'invalid_run_id'
  | 'not_public'
  | 'outside_run'
  | 'not_found'
  | 'too_large';

/** A run artifact was refused or is absent; see {@link ArtifactAccessCode}. */
export class ArtifactAccessError extends RunViewError {
  public override readonly name = 'ArtifactAccessError';

  public constructor(
    public readonly code: ArtifactAccessCode,
    /** The registry entry id, when the path classified to one. */
    public readonly entryId: string | null = null,
  ) {
    super(`Run artifact refused: ${code}${entryId === null ? '' : ` (${entryId})`}.`);
  }
}

/** A Ledger cursor that is not one this build issued. */
export class LedgerCursorError extends RunViewError {
  public override readonly name = 'LedgerCursorError';

  public constructor(public readonly reason: 'encoding' | 'schema') {
    super(
      reason === 'encoding'
        ? 'The Ledger cursor is not valid base64url JSON.'
        : 'The Ledger cursor is not one this version of Yantra issued.',
    );
  }
}
