import { describe, expect, it } from 'vitest';

import { Step } from '../src/index.js';

const base = {
  id: 's1',
  scope: null,
} as const;

describe('@no-llm step schema', () => {
  it('parses one instance of each step variant', () => {
    const variants = [
      { ...base, type: 'navigate', url: { kind: 'literal', value: 'https://example.com' } },
      { ...base, type: 'click', locator: { kind: 'workflow', name: 'Sign in' }, modifiers: null },
      {
        ...base,
        type: 'fill',
        locator: { kind: 'workflow', name: 'Username' },
        value: { kind: 'param', key: 'user' },
        submit: false,
      },
      {
        ...base,
        type: 'extract',
        locator: { kind: 'workflow', name: 'Table' },
        extraction_schema: {
          type: 'object',
          fields: { amount: { type: 'primitive', kind: 'number' } },
        },
        capture_as: 'transactions',
      },
      {
        ...base,
        type: 'wait_for',
        locator: { kind: 'workflow', name: 'Dashboard' },
        state: 'visible',
        timeout_ms: null,
      },
      {
        ...base,
        type: 'assert',
        locator: { kind: 'workflow', name: 'Dashboard' },
        condition: { kind: 'visible' },
      },
      {
        ...base,
        type: 'branch',
        condition: { kind: 'always' },
        then_step_id: 's2',
        else_step_id: null,
      },
      {
        ...base,
        type: 'loop',
        over: { kind: 'param', key: 'items' },
        as: 'item',
        body_step_ids: ['s2'],
        max_iterations: 5,
      },
      {
        ...base,
        type: 'call_workflow',
        workflow_name: 'child',
        params: { month: { kind: 'param', key: 'month' } },
        capture_as: null,
      },
      {
        ...base,
        type: 'llm_summarize',
        input: { kind: 'capture', step_id: 's2', field: null },
        prompt: 'Summarize',
        output_as: 'summary',
      },
    ];

    variants.forEach((variant) => {
      expect(Step.safeParse(variant).success).toBe(true);
    });
  });

  it('rejects invalid discriminator', () => {
    expect(Step.safeParse({ ...base, type: 'unknown' }).success).toBe(false);
  });
});
