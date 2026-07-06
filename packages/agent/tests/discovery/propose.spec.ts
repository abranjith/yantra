import type { Result } from '@yantra/protocol';
import { err, ok } from '@yantra/protocol';
import { describe, expect, it } from 'vitest';

import { InMemoryAuditWriter, InMemoryUsageWriter, wrapWithAudit } from '../../src/audit/wrap.js';
import {
  DEFAULT_BUDGET,
  type LLMClient,
  type SummarizeOpts,
  type SummarizeResult,
} from '../../src/client/interface.js';
import { propose } from '../../src/discovery/propose.js';
import { initDiscoveryState } from '../../src/discovery/session-state.js';

const VALID_NAVIGATE_PROPOSAL = JSON.stringify({
  rationale: 'navigate to the site first',
  steps: [
    {
      id: 's1',
      type: 'navigate',
      scope: null,
      requires_confirmation: false,
      confirmation_description: null,
      expected_cost: null,
      consequence: null,
      url: { kind: 'literal', value: 'https://example.com' },
    },
  ],
  done: null,
});

/** A canned LLMClient whose `summarize` returns a queued sequence of responses. */
class CannedLlmClient implements LLMClient {
  public readonly providerId = 'canned:test';
  public readonly calls: SummarizeOpts[] = [];

  public constructor(private readonly responses: readonly string[]) {}

  public generatePlan(): never {
    throw new Error('not used by propose()');
  }

  public summarize(opts: SummarizeOpts): Promise<Result<SummarizeResult, never>> {
    this.calls.push(opts);
    const index = this.calls.length - 1;
    const text = this.responses[index] ?? this.responses[this.responses.length - 1] ?? '';
    return Promise.resolve(ok({ text, usage: makeUsage() }));
  }
}

function makeUsage() {
  return {
    step_id: null,
    model: 'test',
    provider: 'anthropic' as const,
    input_tokens: 10,
    output_tokens: 5,
    cost_estimate_usd: 0.001,
    latency_ms: 5,
    at: new Date().toISOString(),
  };
}

const baseOpts = { runId: 'run-1', taskId: 'task-1', budget: DEFAULT_BUDGET };

describe('@no-llm discovery propose()', () => {
  it('returns a normalized proposal on the first canned happy-path response', async () => {
    const client = new CannedLlmClient([VALID_NAVIGATE_PROPOSAL]);
    const state = initDiscoveryState({ goal: 'buy shoes', hostAllowlist: ['example.com'] });

    const result = await propose(state, { client }, baseOpts);

    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.rationale).toBe('navigate to the site first');
    // normalizeProposal forces requires_confirmation on the mutating navigate step.
    expect(result.value.steps[0]?.requires_confirmation).toBe(true);
    expect(client.calls).toHaveLength(1);
  });

  it('re-prompts once on malformed JSON, then succeeds', async () => {
    const client = new CannedLlmClient(['not json at all {{{', VALID_NAVIGATE_PROPOSAL]);
    const state = initDiscoveryState({ goal: 'g', hostAllowlist: ['example.com'] });

    const result = await propose(state, { client }, baseOpts);

    expect(result.isOk).toBe(true);
    expect(client.calls).toHaveLength(2);
    const secondPromptInput = client.calls[1]?.sanitizedInput as unknown as string;
    expect(secondPromptInput).toContain('failed validation');
  });

  it('re-prompts on a schema-invalid proposal (locator kind not intent), then succeeds', async () => {
    const invalid = JSON.stringify({
      rationale: 'r',
      steps: [
        {
          id: 's1',
          type: 'click',
          scope: null,
          requires_confirmation: false,
          confirmation_description: null,
          expected_cost: null,
          consequence: null,
          locator: { kind: 'recorded', step_index: 0 },
          modifiers: null,
        },
      ],
      done: null,
    });
    const client = new CannedLlmClient([invalid, VALID_NAVIGATE_PROPOSAL]);
    const state = initDiscoveryState({ goal: 'g', hostAllowlist: [] });

    const result = await propose(state, { client }, baseOpts);

    expect(result.isOk).toBe(true);
    const secondPromptInput = client.calls[1]?.sanitizedInput as unknown as string;
    expect(secondPromptInput).toContain('intent');
  });

  it('rejects a proposal containing a SecretRef and reports it in the re-prompt', async () => {
    const withSecret = JSON.stringify({
      rationale: 'r',
      steps: [
        {
          id: 's1',
          type: 'fill',
          scope: null,
          requires_confirmation: false,
          confirmation_description: null,
          expected_cost: null,
          consequence: null,
          locator: { kind: 'intent', role: 'textbox', name_match: null, near: null },
          value: { kind: 'secret', key: 'bank.password' },
          submit: false,
        },
      ],
      done: null,
    });
    const client = new CannedLlmClient([withSecret, VALID_NAVIGATE_PROPOSAL]);
    const state = initDiscoveryState({ goal: 'g', hostAllowlist: [] });

    const result = await propose(state, { client }, baseOpts);

    expect(result.isOk).toBe(true);
    const secondPromptInput = client.calls[1]?.sanitizedInput as unknown as string;
    expect(secondPromptInput.toLowerCase()).toContain('secretref');
  });

  it('exhausts the re-prompt budget and returns a typed validation_failed error', async () => {
    const client = new CannedLlmClient(['still not json', 'still not json', 'still not json']);
    const state = initDiscoveryState({ goal: 'g', hostAllowlist: [] });

    const result = await propose(state, { client, maxReprompts: 2 }, baseOpts);

    expect(result.isOk).toBe(false);
    if (result.isOk) return;
    expect(result.error.kind).toBe('validation_failed');
    if (result.error.kind === 'validation_failed') {
      expect(result.error.attempts).toBe(3); // 1 initial + 2 re-prompts
    }
    expect(client.calls).toHaveLength(3);
  });

  it('respects a maxReprompts of 0 (single attempt, no retries)', async () => {
    const client = new CannedLlmClient(['not json']);
    const state = initDiscoveryState({ goal: 'g', hostAllowlist: [] });

    const result = await propose(state, { client, maxReprompts: 0 }, baseOpts);

    expect(result.isOk).toBe(false);
    expect(client.calls).toHaveLength(1);
  });

  it('short-circuits immediately on an LLM error without any re-prompt attempt', async () => {
    class FailingClient implements LLMClient {
      public readonly providerId = 'failing:test';
      public generatePlan(): never {
        throw new Error('unused');
      }
      public summarize(): Promise<
        Result<SummarizeResult, { kind: 'llm_unavailable'; reason: 'provider_none'; hint: string }>
      > {
        return Promise.resolve(
          err({ kind: 'llm_unavailable', reason: 'provider_none', hint: 'no provider configured' }),
        );
      }
    }
    const client = new FailingClient();
    const state = initDiscoveryState({ goal: 'g', hostAllowlist: [] });

    const result = await propose(state, { client }, baseOpts);

    expect(result.isOk).toBe(false);
    if (!result.isOk) {
      expect(result.error.kind).toBe('llm_error');
    }
  });

  it('emits paired request/response audit entries per call via wrapWithAudit', async () => {
    const client = new CannedLlmClient([VALID_NAVIGATE_PROPOSAL]);
    const auditWriter = new InMemoryAuditWriter();
    const usageWriter = new InMemoryUsageWriter();
    const wrapped = wrapWithAudit(client, auditWriter, usageWriter, 'run-1');
    const state = initDiscoveryState({ goal: 'g', hostAllowlist: [] });

    const result = await propose(state, { client: wrapped }, baseOpts);

    expect(result.isOk).toBe(true);
    expect(auditWriter.entries).toHaveLength(2); // request + response
    expect(auditWriter.entries[0]?.direction).toBe('request');
    expect(auditWriter.entries[1]?.direction).toBe('response');
    expect(usageWriter.calls).toHaveLength(1);
  });

  it('passes the goal and host allowlist through into the rendered prompt', async () => {
    const client = new CannedLlmClient([VALID_NAVIGATE_PROPOSAL]);
    const state = initDiscoveryState({
      goal: 'find concert tickets',
      hostAllowlist: ['ticketsite.example'],
    });

    await propose(state, { client }, baseOpts);

    const firstInput = client.calls[0]?.sanitizedInput as unknown as string;
    expect(firstInput).toContain('find concert tickets');
    expect(firstInput).toContain('ticketsite.example');
  });
});
