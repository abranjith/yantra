import type { SecurityScope } from '@yantra/protocol';

export interface ScopeViolation {
  readonly stepId: string;
  readonly stepType: string;
  readonly declaredScope: SecurityScope;
  readonly reason: string;
}

export class SecretNotFoundError extends Error {
  override readonly name = 'SecretNotFoundError';

  public constructor(
    public readonly context: {
      readonly key: string;
      readonly stepId: string;
      readonly taskId: string;
    },
  ) {
    super(`Secret "${context.key}" not found for step ${context.stepId}.`);
  }
}

export class KeychainUnavailableError extends Error {
  override readonly name = 'KeychainUnavailableError';

  public constructor(
    message: string,
    public readonly context: {
      readonly operation: 'get' | 'set' | 'delete' | 'list';
      readonly cause?: unknown;
    } = { operation: 'get' },
  ) {
    super(message);
  }
}

export class ScopeViolationError extends Error {
  override readonly name = 'ScopeViolationError';

  public constructor(public readonly violations: readonly ScopeViolation[]) {
    super(`Scope validation failed with ${violations.length} violation(s).`);
  }
}
