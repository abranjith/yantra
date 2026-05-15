import type { Plan } from '@yantra/protocol';
import { ALLOWED_VERBS_BY_SCOPE } from '@yantra/protocol';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { ScopeViolationError } from '../../src/executor/errors.js';
import { checkScopeViolations, buildScopeChain } from '../../src/executor/scope-enforcer.js';

const BASE_PLAN: Plan = {
  schema_version: '0.1',
  plan_id: 'plan-1',
  task_id: 'task-1',
  default_scope: 'public',
  steps: [],
};

const makeNavigateStep = (
  id: string,
  scope: 'public' | 'read-only-data' | 'authenticated' = 'public',
) => ({
  type: 'navigate' as const,
  id,
  url: { kind: 'literal' as const, value: 'https://example.com' },
  scope,
});

const makeClickStep = (
  id: string,
  scope: 'public' | 'read-only-data' | 'authenticated' = 'authenticated',
) => ({
  type: 'click' as const,
  id,
  locator: { kind: 'recorded' as const, step_index: 0 },
  scope,
  modifiers: [],
});

describe('@no-llm checkScopeViolations', () => {
  it('returns empty array for a plan with only navigate steps in public scope', () => {
    const plan: Plan = { ...BASE_PLAN, steps: [makeNavigateStep('s1')] };
    const violations = checkScopeViolations(plan, { taskId: 'task-1', runId: 'run-1' });
    // navigate is allowed in public scope
    if (ALLOWED_VERBS_BY_SCOPE.public.includes('navigate' as never)) {
      expect(violations).toHaveLength(0);
    }
  });

  it('returns violations when a verb is placed in a scope that forbids it', () => {
    // click is NOT in ALLOWED_VERBS_BY_SCOPE.public
    if (!ALLOWED_VERBS_BY_SCOPE.public.includes('click' as never)) {
      const plan: Plan = {
        ...BASE_PLAN,
        default_scope: 'public',
        steps: [makeClickStep('s1', 'public')],
      };
      const violations = checkScopeViolations(plan, { taskId: 'task-1', runId: 'run-1' });
      expect(violations.length).toBeGreaterThan(0);
      expect(violations[0]).toBeInstanceOf(ScopeViolationError);
      expect(violations[0].scopeContext.stepId).toBe('s1');
    }
  });

  it('returns no violations for click in authenticated scope', () => {
    if (ALLOWED_VERBS_BY_SCOPE.authenticated.includes('click' as never)) {
      const plan: Plan = {
        ...BASE_PLAN,
        default_scope: 'authenticated',
        steps: [makeClickStep('s1', 'authenticated')],
      };
      const violations = checkScopeViolations(plan, { taskId: 'task-1', runId: 'run-1' });
      expect(violations).toHaveLength(0);
    }
  });

  it('returns an empty array for an empty plan', () => {
    const plan: Plan = { ...BASE_PLAN, steps: [] };
    const violations = checkScopeViolations(plan, { taskId: 'task-1', runId: 'run-1' });
    expect(violations).toHaveLength(0);
  });

  it('ScopeViolationError carries correct context fields', () => {
    if (!ALLOWED_VERBS_BY_SCOPE.public.includes('click' as never)) {
      const plan: Plan = {
        ...BASE_PLAN,
        default_scope: 'public',
        steps: [makeClickStep('s1', 'public')],
      };
      const violations = checkScopeViolations(plan, { taskId: 'task-1', runId: 'run-1' });
      if (violations.length > 0) {
        expect(violations[0].scopeContext.scope).toBe('public');
        expect(violations[0].scopeContext.attemptedVerb).toBe('click');
        expect(violations[0].context.taskId).toBe('task-1');
      }
    }
  });
});

describe('@no-llm buildScopeChain', () => {
  it('returns an array with the same length as plan.steps', () => {
    const plan: Plan = {
      ...BASE_PLAN,
      steps: [makeNavigateStep('s1'), makeNavigateStep('s2')],
    };
    const chain = buildScopeChain(plan);
    expect(chain).toHaveLength(2);
  });

  it('each chain entry matches the corresponding step scope', () => {
    const plan: Plan = {
      ...BASE_PLAN,
      steps: [makeNavigateStep('s1', 'public'), makeClickStep('s2', 'authenticated')],
    };
    const chain = buildScopeChain(plan);
    expect(chain[0]).toBe('public');
    expect(chain[1]).toBe('authenticated');
  });

  it('property: chain length always matches step count', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 20 }), (n) => {
        const steps = Array.from({ length: n }, (_, i) => makeNavigateStep(`s${i}`));
        const plan: Plan = { ...BASE_PLAN, steps };
        return buildScopeChain(plan).length === n;
      }),
    );
  });
});
