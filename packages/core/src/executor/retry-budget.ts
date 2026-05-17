import { BudgetExhaustedError } from './errors.js';
import type { RetryBudget, RetryBudgetLevels } from './types.js';

const DEFAULT_BUDGETS: RetryBudgetLevels = {
  locatorAttempts: 3,
  stepAttempts: 3,
  workflowAttempts: 1,
};

/**
 * Mutable three-level retry budget.
 *
 * All three counters decrement independently. `canRetry` must be checked
 * before `consume`; defensive `consume` past zero throws `BudgetExhaustedError`.
 */
export class RetryBudgetImpl implements RetryBudget {
  readonly initial: RetryBudgetLevels;
  private _remaining: { locatorAttempts: number; stepAttempts: number; workflowAttempts: number };

  constructor(
    initial: Partial<RetryBudgetLevels> = {},
    private readonly errorContext: { taskId: string; runId: string },
  ) {
    this.initial = { ...DEFAULT_BUDGETS, ...initial };
    this._remaining = { ...this.initial };
  }

  get remaining(): RetryBudgetLevels {
    return { ...this._remaining };
  }

  canRetry(level: 'locator' | 'step' | 'workflow'): boolean {
    return this._remaining[levelKey(level)] > 0;
  }

  consume(level: 'locator' | 'step' | 'workflow'): void {
    const key = levelKey(level);
    if (this._remaining[key] <= 0) {
      throw new BudgetExhaustedError({ level, initial: this.initial[key] }, this.errorContext);
    }
    this._remaining[key]--;
  }

  snapshot(): { locator: number; step: number; workflow: number } {
    return {
      locator: this._remaining.locatorAttempts,
      step: this._remaining.stepAttempts,
      workflow: this._remaining.workflowAttempts,
    };
  }

  clone(): RetryBudget {
    const copy = new RetryBudgetImpl(this.initial, this.errorContext);
    copy._remaining = { ...this._remaining };
    return copy;
  }
}

function levelKey(
  level: 'locator' | 'step' | 'workflow',
): 'locatorAttempts' | 'stepAttempts' | 'workflowAttempts' {
  if (level === 'locator') return 'locatorAttempts';
  if (level === 'step') return 'stepAttempts';
  return 'workflowAttempts';
}
