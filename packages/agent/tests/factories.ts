/**
 * Test factories for @yantra/agent unit tests.
 */
import type { Plan, UsageCall } from '@yantra/protocol';
import { PlanSchema, SCHEMA_VERSION } from '@yantra/protocol';

import type { GeneratePlanOpts, LLMBudget, SummarizeOpts } from '../src/client/interface.js';
import { brandSanitized } from '../src/sanitizer-guard.js';

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

export function makeBudget(overrides: Partial<LLMBudget> = {}): LLMBudget {
  return {
    maxCalls: 3,
    maxLatencyMs: 5_000,
    maxTokensIn: null,
    maxTokensOut: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export function makePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    task_id: '01HZZZZZZZZZZZZZZZZZZZZZZ1',
    plan_id: '01HZZZZZZZZZZZZZZZZZZZZZZ2',
    schema_version: SCHEMA_VERSION,
    default_scope: 'public',
    steps: [
      {
        type: 'navigate',
        id: 's1',
        url: { kind: 'literal', value: 'https://example.com' },
        scope: null,
      },
    ],
    outputs: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// GeneratePlanOpts
// ---------------------------------------------------------------------------

export function makeGeneratePlanOpts(overrides: Partial<GeneratePlanOpts> = {}): GeneratePlanOpts {
  return {
    sanitizedPrompt: brandSanitized('navigate to example.com'),
    toolCatalog: [],
    schema: PlanSchema,
    budget: makeBudget(),
    runId: 'run-test-001',
    taskId: 'task-test-001',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// SummarizeOpts
// ---------------------------------------------------------------------------

export function makeSummarizeOpts(overrides: Partial<SummarizeOpts> = {}): SummarizeOpts {
  return {
    sanitizedInput: brandSanitized('The article content here.'),
    sanitizedPrompt: brandSanitized('Summarize this article.'),
    budget: makeBudget(),
    runId: 'run-test-001',
    taskId: 'task-test-001',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// UsageCall
// ---------------------------------------------------------------------------

export function makeUsageCall(overrides: Partial<UsageCall> = {}): UsageCall {
  return {
    step_id: null,
    model: 'claude-sonnet-4-6',
    provider: 'anthropic',
    input_tokens: 100,
    output_tokens: 50,
    cost_estimate_usd: 0.001,
    latency_ms: 500,
    at: new Date().toISOString(),
    ...overrides,
  };
}
