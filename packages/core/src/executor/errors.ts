import type { FailureClass, SecurityScope } from '@yantra/protocol';

/** Base class for all executor errors — carries structured run context. */
export class ExecutorError extends Error {
  override readonly name: string = 'ExecutorError';

  constructor(
    message: string,
    public readonly context: {
      readonly taskId: string;
      readonly runId: string;
      readonly stepId?: string;
    },
  ) {
    super(message);
  }
}

/** The locator chain exhausted all candidates without finding a match. */
export class ExecutorLocatorNotFoundError extends ExecutorError {
  override readonly name = 'ExecutorLocatorNotFoundError';
  public readonly failureClass: FailureClass = 'locator_not_found';

  constructor(
    public readonly locatorContext: {
      readonly chainName: string;
      readonly candidatesCount: number;
    },
    base: { readonly taskId: string; readonly runId: string; readonly stepId: string },
  ) {
    super(
      `Locator chain "${locatorContext.chainName}" exhausted ${locatorContext.candidatesCount} candidate(s).`,
      base,
    );
  }
}

/** EthicsGate refused the navigation or fetch request. */
export class EthicsRefusedError extends ExecutorError {
  override readonly name = 'EthicsRefusedError';
  public readonly failureClass: FailureClass = 'ethics_refused';

  constructor(
    public readonly ethicsContext: {
      readonly host: string;
      readonly rule: string;
      readonly reason: string;
      readonly source: 'robots' | 'blocklist' | 'rate_limit';
    },
    base: { readonly taskId: string; readonly runId: string; readonly stepId: string },
  ) {
    super(
      `Ethics gate refused access to "${ethicsContext.host}": ${ethicsContext.reason} (source: ${ethicsContext.source})`,
      base,
    );
  }
}

/** A step verb was used inside a scope that forbids it. */
export class ScopeViolationError extends ExecutorError {
  override readonly name = 'ScopeViolationError';
  public readonly failureClass: FailureClass = 'scope_violation';

  constructor(
    public readonly scopeContext: {
      readonly scope: SecurityScope;
      readonly attemptedVerb: string;
      readonly stepId: string;
    },
    base: { readonly taskId: string; readonly runId: string; readonly stepId: string },
  ) {
    super(
      `Scope violation: verb "${scopeContext.attemptedVerb}" is not allowed in "${scopeContext.scope}" scope (step ${scopeContext.stepId}).`,
      base,
    );
  }
}

/** Retry budget consumed past zero. */
export class BudgetExhaustedError extends ExecutorError {
  override readonly name = 'BudgetExhaustedError';
  public readonly failureClass: FailureClass = 'budget_exhausted';

  constructor(
    public readonly budgetContext: {
      readonly level: 'locator' | 'step' | 'workflow';
      readonly initial: number;
    },
    base: { readonly taskId: string; readonly runId: string; readonly stepId?: string },
  ) {
    super(
      `Budget exhausted at level "${budgetContext.level}" (initial: ${budgetContext.initial}).`,
      base,
    );
  }
}

/** HTTP 403, 429, or 451 from the target site. */
export class RemoteRefusedError extends ExecutorError {
  override readonly name = 'RemoteRefusedError';
  public readonly failureClass: FailureClass = 'rate_limited';

  constructor(
    public readonly remoteContext: {
      readonly status: number;
      readonly host: string;
      readonly url: string;
      readonly retryAfterMs?: number;
    },
    base: { readonly taskId: string; readonly runId: string; readonly stepId: string },
  ) {
    super(
      `Remote refused with HTTP ${remoteContext.status} at "${remoteContext.host}".`,
      base,
    );
  }
}

/** Navigation timed out before the page loaded. */
export class NavigationTimeoutError extends ExecutorError {
  override readonly name = 'NavigationTimeoutError';
  public readonly failureClass: FailureClass = 'network_error';

  constructor(
    public readonly navContext: {
      readonly url: string;
      readonly timeoutMs: number;
    },
    base: { readonly taskId: string; readonly runId: string; readonly stepId: string },
  ) {
    super(
      `Navigation to "${navContext.url}" timed out after ${navContext.timeoutMs}ms.`,
      base,
    );
  }
}

/** An AssertStep condition evaluated to false. */
export class AssertFailedError extends ExecutorError {
  override readonly name = 'AssertFailedError';
  public readonly failureClass: FailureClass = 'unexpected';

  constructor(
    public readonly assertContext: {
      readonly conditionKind: string;
      readonly stepId: string;
      readonly detail: string;
    },
    base: { readonly taskId: string; readonly runId: string; readonly stepId: string },
  ) {
    super(
      `Assert step "${assertContext.stepId}" failed (${assertContext.conditionKind}): ${assertContext.detail}`,
      base,
    );
  }
}
