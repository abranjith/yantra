import type { Plan, Step } from '@yantra/protocol';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { ScopeViolationError } from '../../src/secrets/errors.js';
import {
  buildScopeChain,
  enforce,
  validateScopeViolations,
} from '../../src/secrets/scope-enforcer.js';

const basePlan: Omit<Plan, 'steps'> = {
  schema_version: '0.1',
  plan_id: 'plan-1',
  task_id: 'task-1',
  default_scope: 'public',
  outputs: [],
};

function stepForType(type: Step['type'], id: string): Step {
  if (type === 'click') {
    return {
      id,
      type,
      scope: 'read-only-data',
      locator: { kind: 'recorded', step_index: 0 },
      modifiers: null,
    };
  }

  if (type === 'fill') {
    return {
      id,
      type,
      scope: 'read-only-data',
      locator: { kind: 'recorded', step_index: 0 },
      value: { kind: 'literal', value: 'x' },
      submit: false,
    };
  }

  if (type === 'navigate') {
    return {
      id,
      type,
      scope: 'read-only-data',
      url: { kind: 'literal', value: 'https://example.com/dashboard' },
    };
  }

  if (type === 'assert') {
    return {
      id,
      type,
      scope: 'read-only-data',
      locator: { kind: 'recorded', step_index: 0 },
      condition: { kind: 'visible' },
    };
  }

  if (type === 'extract') {
    return {
      id,
      type,
      scope: 'read-only-data',
      locator: { kind: 'recorded', step_index: 0 },
      extraction_schema: { type: 'primitive', kind: 'string' },
      capture_as: 'capture_data',
    };
  }

  if (type === 'wait_for') {
    return {
      id,
      type,
      scope: 'read-only-data',
      locator: { kind: 'recorded', step_index: 0 },
      state: 'visible',
      timeout_ms: null,
    };
  }

  if (type === 'llm_summarize') {
    return {
      id,
      type,
      scope: 'read-only-data',
      input: { kind: 'capture', step_id: 's1', field: null },
      prompt: 'summarize',
      output_as: 'summary',
    };
  }

  return {
    id,
    type: 'branch',
    scope: 'public',
    condition: { kind: 'always' },
    then_step_id: 's1',
    else_step_id: null,
  };
}

describe('@no-llm scope enforcer', () => {
  it('returns no violations for read-only allowed verbs', () => {
    const plan: Plan = {
      ...basePlan,
      steps: [
        stepForType('extract', 's1'),
        stepForType('wait_for', 's2'),
        stepForType('llm_summarize', 's3'),
      ],
    };

    const violations = validateScopeViolations(plan);
    expect(violations).toHaveLength(0);
  });

  it('throws ScopeViolationError from enforce(plan) when violations exist', () => {
    const plan: Plan = {
      ...basePlan,
      steps: [stepForType('click', 's1')],
    };

    expect(() => enforce(plan)).toThrow(ScopeViolationError);
  });

  it('property: mutating verbs inside read-only-data always trigger violations', () => {
    const mutatingStepTypes: Step['type'][] = ['click', 'fill', 'navigate', 'assert'];

    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...mutatingStepTypes), { minLength: 1, maxLength: 8 }),
        (types) => {
          const steps = types.map((type, index) => stepForType(type, `s${index + 1}`));
          const plan: Plan = {
            ...basePlan,
            steps,
          };

          const violations = validateScopeViolations(plan);
          expect(violations.length).toBeGreaterThan(0);

          for (const violation of violations) {
            expect(violation.declaredScope).toBe('read-only-data');
            expect(violation.reason).toContain('Allowed');
          }
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('buildScopeChain aligns with plan step order', () => {
    const plan: Plan = {
      ...basePlan,
      default_scope: 'authenticated',
      steps: [
        {
          id: 's1',
          type: 'navigate',
          scope: null,
          url: { kind: 'literal', value: 'https://example.com' },
        },
        stepForType('extract', 's2'),
      ],
    };

    expect(buildScopeChain(plan)).toEqual(['authenticated', 'read-only-data']);
  });
});
