/**
 * Custom error classes for the workflow replay feature (FEAT-010).
 */

// ---------------------------------------------------------------------------
// Workflow loading errors
// ---------------------------------------------------------------------------

export class WorkflowNotFoundError extends Error {
  override readonly name = 'WorkflowNotFoundError';

  public constructor(
    public readonly workflowName: string,
    public readonly workflowsDir: string,
  ) {
    super(`Workflow "${workflowName}" not found in ${workflowsDir}.`);
  }
}

// ---------------------------------------------------------------------------
// Params errors
// ---------------------------------------------------------------------------

export class ParamsValidationError extends Error {
  override readonly name = 'ParamsValidationError';

  public constructor(
    public readonly paramName: string,
    public readonly reason: string,
    public readonly sanitizedValue?: unknown,
  ) {
    super(`Param "${paramName}": ${reason}`);
  }
}

export class MissingRequiredParamError extends Error {
  override readonly name = 'MissingRequiredParamError';

  public constructor(public readonly missing: readonly string[]) {
    super(
      `Required params are missing: ${missing.join(', ')}. ` +
        `Provide them via --params key=value or --params-file <path>.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Workflow translation errors
// ---------------------------------------------------------------------------

export class WorkflowTranslationError extends Error {
  override readonly name = 'WorkflowTranslationError';

  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Run lifecycle errors
// ---------------------------------------------------------------------------

export class RunNotResumableError extends Error {
  override readonly name = 'RunNotResumableError';

  public constructor(
    public readonly runId: string,
    public readonly currentStatus: string,
    reason?: string,
  ) {
    super(
      reason ??
        `Run "${runId}" cannot be resumed because its status is "${currentStatus}". ` +
          `Only "failed" or "paused" runs can be resumed.`,
    );
  }
}

export class RunDirMissingError extends Error {
  override readonly name = 'RunDirMissingError';

  public constructor(public readonly runId: string) {
    super(`Run directory for "${runId}" does not exist or cannot be read.`);
  }
}

export class RunDirLockedError extends Error {
  override readonly name = 'RunDirLockedError';

  public constructor(
    public readonly runId: string,
    public readonly lockPid: number | null,
  ) {
    super(
      `Run directory for "${runId}" is locked` +
        (lockPid !== null ? ` by PID ${lockPid}` : '') +
        `. Another process may be running this workflow.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Output evaluation errors
// ---------------------------------------------------------------------------

export class OutputEvaluationError extends Error {
  override readonly name = 'OutputEvaluationError';

  public constructor(
    public readonly bindingName: string,
    public readonly expression: string,
    cause: Error,
  ) {
    super(`Output binding "${bindingName}" evaluation failed: ${cause.message}`);
    this.cause = cause;
  }
}
