/**
 * @no-llm Seam contract tests for the agent provider types (plan §4).
 *
 * The compile-time sections are the real assertions: this file is part of
 * `tsconfig.tests.json`, so `pnpm --filter @yantra/agent typecheck` fails if
 * an `AgentEvent` variant is added without updating the exhaustiveness
 * switch, if `AgentAuthSelection` narrowing regresses, or if the
 * `AgentRunResult.outcome` union is widened.
 */

import { describe, expect, it } from 'vitest';

import type {
  AgentAuthSelection,
  AgentEvent,
  AgentProvider,
  AgentRunResult,
  AgentSessionOptions,
  AgentUsage,
} from '../../src/provider/index.js';

import { FakeAgentProvider } from './fake-provider.js';

// ---------------------------------------------------------------------------
// Compile-time: AgentEvent discriminant exhaustiveness.
// Adding a variant to the union without a case here is a build failure.
// ---------------------------------------------------------------------------

function assertNever(value: never): never {
  throw new Error(`Unexpected AgentEvent variant: ${JSON.stringify(value)}`);
}

function describeEvent(event: AgentEvent): string {
  switch (event.type) {
    case 'tool_started':
      return `${event.tool}:${event.callId} started at ${event.at}`;
    case 'tool_finished':
      return `${event.tool}:${event.callId} finished (error=${String(event.isError)})`;
    case 'assistant_text':
      return `text(${event.text.length})`;
    case 'turn_finished':
      return `turn ${event.usage.turns}`;
    case 'failed':
      return `failed ${event.error.code}: ${event.error.message}`;
    default:
      return assertNever(event);
  }
}

// ---------------------------------------------------------------------------
// Compile-time: AgentAuthSelection narrowing.
// `secretRef` exists only on the runtime-key branch.
// ---------------------------------------------------------------------------

function describeAuth(auth: AgentAuthSelection): string {
  if (auth.mode === 'runtime-key') {
    return `runtime-key via ${auth.secretRef}`;
  }
  // @ts-expect-error — `secretRef` must not exist on the managed branch.
  return `managed (${String(auth.secretRef)})`;
}

// ---------------------------------------------------------------------------
// Compile-time: AgentRunResult.outcome is a closed union.
// ---------------------------------------------------------------------------

const completedOutcome: AgentRunResult['outcome'] = 'completed';
const failedOutcome: AgentRunResult['outcome'] = 'failed';
const abortedOutcome: AgentRunResult['outcome'] = 'aborted';
// @ts-expect-error — 'budget_exhausted' is a run-level state, not a seam outcome.
const invalidOutcome: AgentRunResult['outcome'] = 'budget_exhausted';

const OPTIONS: AgentSessionOptions = {
  runId: 'run-123',
  runDir: '/tmp/runs/run-123',
  cwd: '/tmp/project',
  model: { provider: 'anthropic', id: 'claude-sonnet-5' },
  auth: { mode: 'managed' },
  systemPrompt: 'agent-v1 system prompt',
};

describe('@no-llm agent provider seam contract', () => {
  it('a fake in-memory provider satisfies the AgentProvider seam', async () => {
    // The type ascription is the assertion: FakeAgentProvider must remain
    // structurally compatible with the seam for FEAT-026 to reuse it.
    const provider: AgentProvider = new FakeAgentProvider();
    const session = await provider.open(OPTIONS);

    expect(session.id).toBe('fake-session-run-123');
    expect(session.logPath).toContain('/agent/');
  });

  it('delivers scripted events to subscribers and stops after unsubscribe', async () => {
    const events: AgentEvent[] = [
      {
        type: 'tool_started',
        callId: 'c1',
        tool: 'status',
        input: { probe: true },
        at: '2026-07-14T00:00:00.000Z',
      },
      {
        type: 'tool_finished',
        callId: 'c1',
        tool: 'status',
        output: { ok: true },
        isError: false,
        at: '2026-07-14T00:00:01.000Z',
      },
      { type: 'assistant_text', text: 'done', at: '2026-07-14T00:00:02.000Z' },
      { type: 'turn_finished', usage: { turns: 1 }, at: '2026-07-14T00:00:03.000Z' },
    ];

    const provider = new FakeAgentProvider({ eventsOnRun: events });
    const session = await provider.open(OPTIONS);

    const seen: string[] = [];
    const unsubscribe = session.subscribe((event) => seen.push(describeEvent(event)));
    await session.run('do the thing');

    expect(seen).toEqual([
      'status:c1 started at 2026-07-14T00:00:00.000Z',
      'status:c1 finished (error=false)',
      'text(4)',
      'turn 1',
    ]);

    unsubscribe();
    await session.run('again');
    expect(seen).toHaveLength(4);
  });

  it('run() resolves the scripted terminal result', async () => {
    const usage: AgentUsage = { turns: 2, inputTokens: 100, outputTokens: 50, costUsd: 0.01 };
    const provider = new FakeAgentProvider({
      runResult: { outcome: 'failed', stopReason: 'error', usage },
    });
    const session = await provider.open(OPTIONS);

    const result = await session.run('goal');
    expect(result.outcome).toBe(failedOutcome);
    expect(result.usage).toEqual(usage);
  });

  it('narrows AgentAuthSelection by mode', () => {
    expect(describeAuth({ mode: 'runtime-key', secretRef: 'secret://anthropic' })).toBe(
      'runtime-key via secret://anthropic',
    );
    expect([completedOutcome, abortedOutcome, invalidOutcome]).toContain('completed');
  });

  it('the failed event carries a stable-coded sanitized error', () => {
    const failed: AgentEvent = {
      type: 'failed',
      error: { code: 'AGENT_SESSION_START_FAILED', message: 'provider unavailable' },
      at: '2026-07-14T00:00:00.000Z',
    };
    expect(describeEvent(failed)).toBe('failed AGENT_SESSION_START_FAILED: provider unavailable');
  });
});
