import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { BudgetExhaustedError } from '../../src/executor/errors.js';
import { RetryBudgetImpl } from '../../src/executor/retry-budget.js';

const BASE = { taskId: 'task-1', runId: 'run-1' };

describe('@no-llm RetryBudgetImpl', () => {
  describe('construction', () => {
    it('remaining equals initial on creation', () => {
      const b = new RetryBudgetImpl(
        { locatorAttempts: 3, stepAttempts: 2, workflowAttempts: 1 },
        BASE,
      );
      expect(b.remaining.locatorAttempts).toBe(3);
      expect(b.remaining.stepAttempts).toBe(2);
      expect(b.remaining.workflowAttempts).toBe(1);
      expect(b.initial.locatorAttempts).toBe(3);
    });

    it('uses default budgets when none provided', () => {
      const b = new RetryBudgetImpl({}, BASE);
      expect(b.initial.locatorAttempts).toBeGreaterThan(0);
    });
  });

  describe('canRetry / consume', () => {
    it('canRetry returns true while tokens remain', () => {
      const b = new RetryBudgetImpl({ locatorAttempts: 2 }, BASE);
      expect(b.canRetry('locator')).toBe(true);
    });

    it('canRetry returns false when tokens are zero', () => {
      const b = new RetryBudgetImpl(
        { locatorAttempts: 0, stepAttempts: 0, workflowAttempts: 0 },
        BASE,
      );
      expect(b.canRetry('locator')).toBe(false);
    });

    it('consume decrements remaining', () => {
      const b = new RetryBudgetImpl({ locatorAttempts: 3 }, BASE);
      b.consume('locator');
      expect(b.remaining.locatorAttempts).toBe(2);
    });

    it('consume throws BudgetExhaustedError when already at zero', () => {
      const b = new RetryBudgetImpl(
        { locatorAttempts: 1, stepAttempts: 0, workflowAttempts: 0 },
        BASE,
      );
      b.consume('locator');
      expect(() => b.consume('locator')).toThrow(BudgetExhaustedError);
    });

    it('consume on one level does not affect other levels', () => {
      const b = new RetryBudgetImpl(
        { locatorAttempts: 3, stepAttempts: 3, workflowAttempts: 3 },
        BASE,
      );
      b.consume('locator');
      expect(b.remaining.stepAttempts).toBe(3);
      expect(b.remaining.workflowAttempts).toBe(3);
    });
  });

  describe('snapshot / restore', () => {
    it('snapshot captures current remaining counts', () => {
      const b = new RetryBudgetImpl(
        { locatorAttempts: 3, stepAttempts: 2, workflowAttempts: 1 },
        BASE,
      );
      b.consume('locator');
      const snap = b.snapshot();
      expect(snap.locator).toBe(2);
      expect(snap.step).toBe(2);
      expect(snap.workflow).toBe(1);
    });

    it('clone creates an independent copy', () => {
      const b = new RetryBudgetImpl({ locatorAttempts: 3 }, BASE);
      const c = b.clone();
      b.consume('locator');
      expect(c.remaining.locatorAttempts).toBe(3); // clone unaffected
    });
  });

  describe('property: consuming n times leaves initial - n tokens', () => {
    it('property test with fast-check', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 20 }),
          fc.integer({ min: 0, max: 20 }),
          (initial, consumes) => {
            const b = new RetryBudgetImpl(
              { locatorAttempts: initial, stepAttempts: 0, workflowAttempts: 0 },
              BASE,
            );
            const actualConsumes = Math.min(consumes, initial);
            for (let i = 0; i < actualConsumes; i++) b.consume('locator');
            return b.remaining.locatorAttempts === initial - actualConsumes;
          },
        ),
      );
    });
  });
});
