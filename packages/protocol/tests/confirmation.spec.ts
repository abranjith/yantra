// @no-llm
import { describe, expect, it } from 'vitest';

import {
  ConfirmationDecision,
  ConfirmationRequest,
  Step,
  TaskEvent,
  WorkflowFile,
  WorkflowStep,
} from '../src/index.js';

const VALID_ULID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const at = '2026-07-01T00:00:00.000Z';
const task_id = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

describe('ConfirmationRequest schema', () => {
  it('parses a well-formed request', () => {
    const req = {
      confirmation_id: VALID_ULID,
      run_id: 'run-123',
      step_id: 's3',
      action_kind: 'click',
      host: 'bank.example.com',
      description: 'Click "Confirm transfer" button',
      expected_cost: { amount: 500, currency: 'USD' },
      consequence: 'hard_to_reverse',
      requested_at: at,
      timeout_ms: null,
    };
    expect(ConfirmationRequest.safeParse(req).success).toBe(true);
  });

  it('parses a request with null cost and default consequence', () => {
    const req = {
      confirmation_id: VALID_ULID,
      run_id: 'run-123',
      step_id: 's1',
      action_kind: 'navigate',
      host: 'shop.example.com',
      description: 'Navigate to checkout page',
      expected_cost: null,
      consequence: 'unknown',
      requested_at: at,
      timeout_ms: 30000,
    };
    const result = ConfirmationRequest.safeParse(req);
    expect(result.success).toBe(true);
  });

  it('rejects an invalid action_kind', () => {
    const req = {
      confirmation_id: VALID_ULID,
      run_id: 'run-123',
      step_id: 's1',
      action_kind: 'extract',
      host: 'example.com',
      description: 'Extract data',
      expected_cost: null,
      consequence: 'unknown',
      requested_at: at,
      timeout_ms: null,
    };
    expect(ConfirmationRequest.safeParse(req).success).toBe(false);
  });

  it('rejects a malformed ULID', () => {
    const req = {
      confirmation_id: 'not-a-ulid',
      run_id: 'run-123',
      step_id: 's1',
      action_kind: 'click',
      host: 'example.com',
      description: 'Click button',
      expected_cost: null,
      consequence: 'unknown',
      requested_at: at,
      timeout_ms: null,
    };
    expect(ConfirmationRequest.safeParse(req).success).toBe(false);
  });

  it('rejects an empty description', () => {
    const req = {
      confirmation_id: VALID_ULID,
      run_id: 'run-123',
      step_id: 's1',
      action_kind: 'click',
      host: 'example.com',
      description: '',
      expected_cost: null,
      consequence: 'unknown',
      requested_at: at,
      timeout_ms: null,
    };
    expect(ConfirmationRequest.safeParse(req).success).toBe(false);
  });
});

describe('ConfirmationDecision schema', () => {
  it('parses a granted decision with user_interactive provenance', () => {
    const decision = {
      confirmation_id: VALID_ULID,
      decision: 'granted',
      decided_at: at,
      decided_by: 'user_interactive',
    };
    expect(ConfirmationDecision.safeParse(decision).success).toBe(true);
  });

  it('parses a denied decision with user_cli_confirm provenance', () => {
    const decision = {
      confirmation_id: VALID_ULID,
      decision: 'denied',
      decided_at: at,
      decided_by: 'user_cli_confirm',
    };
    expect(ConfirmationDecision.safeParse(decision).success).toBe(true);
  });

  it('parses a timed_out decision', () => {
    const decision = {
      confirmation_id: VALID_ULID,
      decision: 'timed_out',
      decided_at: at,
      decided_by: 'timeout',
    };
    expect(ConfirmationDecision.safeParse(decision).success).toBe(true);
  });

  it('rejects an agent-shaped decided_by variant', () => {
    const decision = {
      confirmation_id: VALID_ULID,
      decision: 'granted',
      decided_at: at,
      decided_by: 'agent',
    };
    expect(ConfirmationDecision.safeParse(decision).success).toBe(false);
  });

  it('rejects an invalid decision value', () => {
    const decision = {
      confirmation_id: VALID_ULID,
      decision: 'maybe',
      decided_at: at,
      decided_by: 'user_interactive',
    };
    expect(ConfirmationDecision.safeParse(decision).success).toBe(false);
  });
});

describe('Step schema — requires_confirmation', () => {
  const base = { id: 's1', scope: null } as const;

  it('defaults requires_confirmation to false when absent', () => {
    const step = {
      ...base,
      type: 'navigate',
      url: { kind: 'literal', value: 'https://example.com' },
    };
    const result = Step.safeParse(step);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.requires_confirmation).toBe(false);
    }
  });

  it('accepts requires_confirmation on a navigate step', () => {
    const step = {
      ...base,
      requires_confirmation: true,
      confirmation_description: 'Navigate to checkout',
      expected_cost: null,
      consequence: 'reversible',
      type: 'navigate',
      url: { kind: 'literal', value: 'https://example.com' },
    };
    expect(Step.safeParse(step).success).toBe(true);
  });

  it('accepts requires_confirmation on a click step', () => {
    const step = {
      ...base,
      requires_confirmation: true,
      confirmation_description: null,
      expected_cost: null,
      consequence: null,
      type: 'click',
      locator: { kind: 'workflow', name: 'Buy button' },
      modifiers: null,
    };
    expect(Step.safeParse(step).success).toBe(true);
  });

  it('accepts requires_confirmation on a fill step', () => {
    const step = {
      ...base,
      requires_confirmation: true,
      confirmation_description: 'Fill credit card number',
      expected_cost: null,
      consequence: 'hard_to_reverse',
      type: 'fill',
      locator: { kind: 'workflow', name: 'Card number' },
      value: { kind: 'secret', key: 'shop.card' },
      submit: false,
    };
    expect(Step.safeParse(step).success).toBe(true);
  });

  it('rejects requires_confirmation on an extract step', () => {
    const step = {
      ...base,
      requires_confirmation: true,
      type: 'extract',
      locator: { kind: 'workflow', name: 'Table' },
      extraction_schema: { type: 'primitive', kind: 'string' },
      capture_as: 'data',
    };
    const result = Step.safeParse(step);
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.includes('requires_confirmation'));
      expect(issue).toBeDefined();
      expect(issue?.message).toContain('extract');
    }
  });

  it('rejects requires_confirmation on a wait_for step', () => {
    const step = {
      ...base,
      requires_confirmation: true,
      type: 'wait_for',
      locator: { kind: 'workflow', name: 'Dashboard' },
      state: 'visible',
      timeout_ms: null,
    };
    expect(Step.safeParse(step).success).toBe(false);
  });

  it('rejects requires_confirmation on a branch step', () => {
    const step = {
      ...base,
      requires_confirmation: true,
      type: 'branch',
      condition: { kind: 'always' },
      then_step_id: 's2',
      else_step_id: null,
    };
    expect(Step.safeParse(step).success).toBe(false);
  });

  it('rejects requires_confirmation on a loop step', () => {
    const step = {
      ...base,
      requires_confirmation: true,
      type: 'loop',
      over: { kind: 'param', key: 'items' },
      as: 'item',
      body_step_ids: ['s2'],
      max_iterations: 5,
    };
    expect(Step.safeParse(step).success).toBe(false);
  });

  it('rejects requires_confirmation on an assert step', () => {
    const step = {
      ...base,
      requires_confirmation: true,
      type: 'assert',
      locator: { kind: 'workflow', name: 'Dashboard' },
      condition: { kind: 'visible' },
    };
    expect(Step.safeParse(step).success).toBe(false);
  });

  it('rejects requires_confirmation on an llm_summarize step', () => {
    const step = {
      ...base,
      requires_confirmation: true,
      type: 'llm_summarize',
      input: { kind: 'capture', step_id: 's2', field: null },
      prompt: 'Summarize',
      output_as: 'summary',
    };
    expect(Step.safeParse(step).success).toBe(false);
  });
});

describe('WorkflowStep schema — requires_confirmation', () => {
  it('accepts requires_confirmation on a navigate workflow step', () => {
    const step = {
      id: 's1',
      scope: null,
      requires_confirmation: true,
      confirmation_description: 'Go to checkout',
      expected_cost: null,
      consequence: null,
      verb: 'navigate',
      url: 'https://shop.example.com/checkout',
    };
    expect(WorkflowStep.safeParse(step).success).toBe(true);
  });

  it('accepts requires_confirmation on a click workflow step', () => {
    const step = {
      id: 's1',
      scope: null,
      requires_confirmation: true,
      confirmation_description: null,
      expected_cost: null,
      consequence: null,
      verb: 'click',
      locator: 'Buy button',
    };
    expect(WorkflowStep.safeParse(step).success).toBe(true);
  });

  it('rejects requires_confirmation on an extract workflow step', () => {
    const step = {
      id: 's1',
      scope: null,
      requires_confirmation: true,
      verb: 'extract',
      locator: 'Data',
      extraction_schema: { type: 'primitive', kind: 'string' },
      capture_as: 'result',
    };
    expect(WorkflowStep.safeParse(step).success).toBe(false);
  });
});

describe('Legacy workflow regression — requires_confirmation absent', () => {
  it('parses a legacy workflow without requires_confirmation fields', () => {
    const workflow: unknown = {
      version: 1,
      name: 'legacy-workflow',
      description: null,
      security_class: 'public',
      recorded_with: null,
      params: {},
      secrets: [],
      cookies: 'none',
      steps: [
        { id: 's1', verb: 'navigate', url: 'https://example.com', scope: null },
        { id: 's2', verb: 'click', locator: 'Submit', scope: null },
      ],
      outputs: [],
      outputs_unredacted: false,
      _unrecorded_frames: [],
      _locators: {},
    };
    const result = WorkflowFile.safeParse(workflow);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.steps[0]?.requires_confirmation).toBe(false);
      expect(result.data.steps[1]?.requires_confirmation).toBe(false);
    }
  });
});

describe('TaskEvent — confirmation variants', () => {
  it('parses a confirmation_requested event', () => {
    const event = {
      kind: 'confirmation_requested',
      task_id,
      at,
      request: {
        confirmation_id: VALID_ULID,
        run_id: 'run-123',
        step_id: 's3',
        action_kind: 'click',
        host: 'bank.example.com',
        description: 'Click "Confirm transfer" button',
        expected_cost: { amount: 500, currency: 'USD' },
        consequence: 'hard_to_reverse',
        requested_at: at,
        timeout_ms: null,
      },
    };
    expect(TaskEvent.safeParse(event).success).toBe(true);
  });

  it('parses a confirmation_resolved event with granted', () => {
    const event = {
      kind: 'confirmation_resolved',
      task_id,
      at,
      confirmation_id: VALID_ULID,
      decision: 'granted',
      decided_by: 'user_interactive',
    };
    expect(TaskEvent.safeParse(event).success).toBe(true);
  });

  it('parses a confirmation_resolved event with denied', () => {
    const event = {
      kind: 'confirmation_resolved',
      task_id,
      at,
      confirmation_id: VALID_ULID,
      decision: 'denied',
      decided_by: 'user_cli_confirm',
    };
    expect(TaskEvent.safeParse(event).success).toBe(true);
  });

  it('parses a confirmation_resolved event with timed_out', () => {
    const event = {
      kind: 'confirmation_resolved',
      task_id,
      at,
      confirmation_id: VALID_ULID,
      decision: 'timed_out',
      decided_by: 'timeout',
    };
    expect(TaskEvent.safeParse(event).success).toBe(true);
  });

  it('rejects a confirmation_resolved event with agent decided_by', () => {
    const event = {
      kind: 'confirmation_resolved',
      task_id,
      at,
      confirmation_id: VALID_ULID,
      decision: 'granted',
      decided_by: 'agent',
    };
    expect(TaskEvent.safeParse(event).success).toBe(false);
  });
});

describe('Property: malformed confirmations never panic the validator', () => {
  it('returns safeParse false (not throw) for various malformed inputs', () => {
    const malformed = [
      null,
      undefined,
      '',
      42,
      [],
      { confirmation_id: 'short' },
      { confirmation_id: VALID_ULID, decision: 'granted' },
      {
        confirmation_id: VALID_ULID,
        decision: 'granted',
        decided_at: 'not-a-date',
        decided_by: 'user_interactive',
      },
    ];
    for (const input of malformed) {
      expect(() => ConfirmationDecision.safeParse(input)).not.toThrow();
      expect(() => ConfirmationRequest.safeParse(input)).not.toThrow();
    }
  });
});
