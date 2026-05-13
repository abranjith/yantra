import { describe, expect, it } from 'vitest';

import { PlanSchema, assertSameTask } from '../src/index.js';

import { makePlan, makeTaskRequest } from './factories.js';

describe('@no-llm plan and task schemas', () => {
  it('enforces max 64 steps', () => {
    const plan = makePlan({
      steps: Array.from({ length: 65 }, (_, index) => ({
        id: `s${index + 1}`,
        scope: null,
        type: 'navigate',
        url: { kind: 'literal', value: 'https://example.com' },
      })),
    });

    expect(PlanSchema.safeParse(plan).success).toBe(false);
  });

  it('asserts task ids must match', () => {
    const request = makeTaskRequest();
    const plan = makePlan();
    expect(assertSameTask(request, plan).isOk).toBe(true);

    const mismatch = assertSameTask(request, { ...plan, task_id: '01ARZ3NDEKTSV4RRFFQ69G5FAZ' });
    expect(mismatch.isOk).toBe(false);
  });

  it('round-trips a valid plan through JSON serialization', () => {
    const parsed = PlanSchema.parse(makePlan());
    const reparsed = PlanSchema.parse(JSON.parse(JSON.stringify(parsed)));
    expect(reparsed).toEqual(parsed);
  });
});
