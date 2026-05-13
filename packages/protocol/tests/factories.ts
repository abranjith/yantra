import type { Plan, Step, TaskRequest, WorkflowFile } from '../src/index.js';
import { SCHEMA_VERSION } from '../src/index.js';

export const makeStep = (overrides: Partial<Step> = {}): Step => {
  const base: Step = {
    id: 's1',
    scope: null,
    type: 'extract',
    locator: { kind: 'workflow', name: 'Transactions table' },
    extraction_schema: {
      type: 'object',
      fields: {
        amount: { type: 'primitive', kind: 'number' },
        desc: { type: 'primitive', kind: 'string' },
      },
    },
    capture_as: 'transactions',
  };

  return { ...base, ...overrides } as Step;
};

export const makePlan = (overrides: Partial<Plan> = {}): Plan => {
  const base: Plan = {
    task_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    plan_id: '01ARZ3NDEKTSV4RRFFQ69G5FAX',
    schema_version: SCHEMA_VERSION,
    default_scope: 'public',
    steps: [makeStep()],
    outputs: [],
  };

  return { ...base, ...overrides };
};

export const makeTaskRequest = (overrides: Partial<TaskRequest> = {}): TaskRequest => {
  const base: TaskRequest = {
    task_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    type: 'ask',
    intent: 'summarize transactions',
    params: {},
    data_refs: [],
    deadline_ms: null,
    budget: null,
    security_class: 'public',
    schema_version: SCHEMA_VERSION,
  };

  return { ...base, ...overrides };
};

export const makeWorkflow = (overrides: Partial<WorkflowFile> = {}): WorkflowFile => {
  const base: WorkflowFile = {
    version: 1,
    name: 'bank-statement',
    description: null,
    security_class: 'public',
    recorded_with: null,
    params: {
      month: {
        type: 'string',
        example: '2026-04',
        required: true,
      },
    },
    secrets: ['bank.password'],
    cookies: 'none',
    steps: [
      {
        id: 's1',
        scope: null,
        verb: 'extract',
        locator: 'Transactions table',
        extraction_schema: {
          type: 'object',
          fields: {
            amount: { type: 'primitive', kind: 'number' },
          },
        },
        capture_as: 'transactions',
      },
    ],
    outputs: [
      {
        name: 'summary',
        from: '{{ capture:transactions }}',
      },
    ],
    outputs_unredacted: false,
    _unrecorded_frames: [],
    _locators: {
      'Transactions table': [{ kind: 'role', role: 'table', name: 'Transactions' }],
    },
  };

  return { ...base, ...overrides };
};
