// @no-llm
import type {
  AgentEvent,
  AgentProvider,
  AgentRunResult,
  AgentSession,
  AgentSessionOptions,
  AgentUsage,
} from '@yantra/agent';
import { AgentModelNotFoundError, PiAgentProvider } from '@yantra/agent';
import type { Logger } from '@yantra/core';
import { describe, expect, it, vi } from 'vitest';

import { createSynthesisLlm } from '../src/synthesis-llm.js';

const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const model = { provider: 'anthropic', id: 'claude-haiku-4-5' } as const;

interface FakeSessionScript {
  /** Events emitted (in order) while `run()` is in flight. */
  readonly events?: readonly AgentEvent[];
  /** Terminal result of `run()`. */
  readonly result?: AgentRunResult;
  /** When set, `run()` rejects with this error instead of resolving. */
  readonly runRejects?: Error;
}

interface FakeProvider extends AgentProvider {
  readonly openCalls: AgentSessionOptions[];
  readonly closeCalls: () => number;
}

const completedResult: AgentRunResult = {
  outcome: 'completed',
  stopReason: 'end_turn',
  usage: { turns: 1 },
};

function textEvent(text: string): AgentEvent {
  return { type: 'assistant_text', text, at: '2026-07-28T00:00:00.000Z' };
}

function turnFinished(usage: AgentUsage): AgentEvent {
  return { type: 'turn_finished', usage, at: '2026-07-28T00:00:00.000Z' };
}

/** A provider whose single session replays a scripted event stream. */
function makeProvider(script: FakeSessionScript = {}): FakeProvider {
  const openCalls: AgentSessionOptions[] = [];
  let closes = 0;

  const provider: FakeProvider = {
    openCalls,
    closeCalls: () => closes,
    open: (options: AgentSessionOptions): Promise<AgentSession> => {
      openCalls.push(options);
      const listeners = new Set<(event: AgentEvent) => void>();

      const session: AgentSession = {
        id: 'session-1',
        logPath: '/tmp/run/agent/session.jsonl',
        authSource: 'managed',
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        run: async (): Promise<AgentRunResult> => {
          for (const event of script.events ?? []) {
            for (const listener of listeners) listener(event);
          }
          if (script.runRejects !== undefined) throw script.runRejects;
          return script.result ?? completedResult;
        },
        abort: () => Promise.resolve(),
        close: () => {
          closes += 1;
          return Promise.resolve();
        },
      };
      return Promise.resolve(session);
    },
  };

  return provider;
}

function makeLlm(provider: AgentProvider) {
  return createSynthesisLlm({
    provider,
    model,
    auth: { mode: 'managed' },
    runId: 'run-1',
    runDir: '/tmp/run-1',
    cwd: '/tmp',
    logger,
  });
}

describe('@no-llm createSynthesisLlm', () => {
  it('exposes provider:model as its providerId', () => {
    expect(makeLlm(makeProvider()).providerId).toBe('anthropic:claude-haiku-4-5');
  });

  it('concatenates assistant_text deltas in order', async () => {
    const provider = makeProvider({
      events: [textEvent('{"title":'), textEvent('"A",'), textEvent('"overview":"B"}')],
    });

    const result = await makeLlm(provider).send({ system: 'sys', user: 'usr' });

    expect(result.isOk).toBe(true);
    expect(result.isOk && result.value.text).toBe('{"title":"A","overview":"B"}');
  });

  it('opens the session with the template system prompt and run identity', async () => {
    const provider = makeProvider({ events: [textEvent('ok')] });

    await makeLlm(provider).send({ system: 'SYSTEM TEXT', user: 'USER TEXT' });

    expect(provider.openCalls).toHaveLength(1);
    expect(provider.openCalls[0]).toMatchObject({
      runId: 'run-1',
      runDir: '/tmp/run-1',
      cwd: '/tmp',
      systemPrompt: 'SYSTEM TEXT',
      model,
      auth: { mode: 'managed' },
    });
  });

  it('returns usage from turn_finished', async () => {
    const provider = makeProvider({
      events: [
        textEvent('ok'),
        turnFinished({ turns: 1, inputTokens: 1200, outputTokens: 340, costUsd: 0.0042 }),
      ],
    });

    const result = await makeLlm(provider).send({ system: 's', user: 'u' });

    expect(result.isOk && result.value.usage).toEqual({
      inputTokens: 1200,
      outputTokens: 340,
      costUsd: 0.0042,
    });
  });

  it('defaults unreported usage fields to zero when some are present', async () => {
    const provider = makeProvider({
      events: [textEvent('ok'), turnFinished({ turns: 1, inputTokens: 10 })],
    });

    const result = await makeLlm(provider).send({ system: 's', user: 'u' });

    expect(result.isOk && result.value.usage).toEqual({
      inputTokens: 10,
      outputTokens: 0,
      costUsd: 0,
    });
  });

  it('returns null usage when the provider reports none', async () => {
    const provider = makeProvider({ events: [textEvent('ok'), turnFinished({ turns: 1 })] });

    const result = await makeLlm(provider).send({ system: 's', user: 'u' });

    expect(result.isOk).toBe(true);
    expect(result.isOk && result.value.usage).toBeNull();
  });

  it('maps a startup error at open to llm_unavailable', async () => {
    const provider: AgentProvider = {
      open: () =>
        Promise.reject(new AgentModelNotFoundError('anthropic', 'nope', 'Known models: ...')),
    };

    const result = await makeLlm(provider).send({ system: 's', user: 'u' });

    expect(result.isOk).toBe(false);
    expect(!result.isOk && result.error.kind).toBe('llm_unavailable');
    expect(!result.isOk && result.error.message).toContain('nope');
  });

  it('maps a non-typed throw at open to llm_unavailable too', async () => {
    const provider: AgentProvider = { open: () => Promise.reject(new Error('socket closed')) };

    const result = await makeLlm(provider).send({ system: 's', user: 'u' });

    expect(!result.isOk && result.error.kind).toBe('llm_unavailable');
  });

  it('maps a failed event to llm_failed', async () => {
    const provider = makeProvider({
      events: [
        {
          type: 'failed',
          error: { code: 'AGENT_TOOL_FAILED', message: 'provider 503' },
          at: '2026-07-28T00:00:00.000Z',
        },
      ],
      result: { outcome: 'failed', stopReason: 'error', usage: { turns: 1 } },
    });

    const result = await makeLlm(provider).send({ system: 's', user: 'u' });

    expect(!result.isOk && result.error.kind).toBe('llm_failed');
    expect(!result.isOk && result.error.kind === 'llm_failed' && result.error.retryable).toBe(true);
  });

  it('treats a failed event with an unusable-credential code as llm_unavailable', async () => {
    const provider = makeProvider({
      events: [
        {
          type: 'failed',
          error: { code: 'AGENT_AUTH_UNAVAILABLE', message: 'no credentials' },
          at: '2026-07-28T00:00:00.000Z',
        },
      ],
      result: { outcome: 'failed', stopReason: 'error', usage: { turns: 1 } },
    });

    const result = await makeLlm(provider).send({ system: 's', user: 'u' });

    expect(!result.isOk && result.error.kind).toBe('llm_unavailable');
  });

  it('maps an aborted outcome to a non-retryable llm_failed', async () => {
    const provider = makeProvider({
      result: { outcome: 'aborted', stopReason: 'user_abort', usage: { turns: 0 } },
    });

    const result = await makeLlm(provider).send({ system: 's', user: 'u' });

    expect(!result.isOk && result.error.kind).toBe('llm_failed');
    expect(!result.isOk && result.error.kind === 'llm_failed' && result.error.retryable).toBe(
      false,
    );
  });

  it('returns a typed error and never throws when run() rejects', async () => {
    const provider = makeProvider({ runRejects: new Error('run after close') });

    const result = await makeLlm(provider).send({ system: 's', user: 'u' });

    expect(!result.isOk && result.error.kind).toBe('llm_failed');
  });

  it('closes the session even when run() rejects', async () => {
    const provider = makeProvider({ runRejects: new Error('boom') });

    await makeLlm(provider).send({ system: 's', user: 'u' });

    expect(provider.closeCalls()).toBe(1);
  });

  it('closes the session on the success path', async () => {
    const provider = makeProvider({ events: [textEvent('ok')] });

    await makeLlm(provider).send({ system: 's', user: 'u' });

    expect(provider.closeCalls()).toBe(1);
  });

  it('opens one session per send call', async () => {
    const provider = makeProvider({ events: [textEvent('ok')] });
    const llm = makeLlm(provider);

    await llm.send({ system: 's', user: 'first' });
    await llm.send({ system: 's', user: 'second' });

    expect(provider.openCalls).toHaveLength(2);
    expect(provider.closeCalls()).toBe(2);
  });

  it('is constructed against a provider carrying zero tools', () => {
    // The synthesis session must be a pure completion endpoint. `PiAgentProvider`
    // takes its tool set through constructor options, so "no tools" is expressed
    // by constructing it with none — there is no tool surface to disable later.
    const provider = new PiAgentProvider();

    const llm = createSynthesisLlm({
      provider,
      model,
      auth: { mode: 'managed' },
      runId: 'run-1',
      runDir: '/tmp/run-1',
      cwd: '/tmp',
      logger,
    });

    expect(llm.providerId).toBe('anthropic:claude-haiku-4-5');
    expect(
      (provider as unknown as { options: { customTools?: readonly unknown[] } }).options
        .customTools,
    ).toBeUndefined();
  });
});
