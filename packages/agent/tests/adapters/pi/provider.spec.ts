/**
 * @no-llm PiAgentProvider adapter tests (FEAT-022 TASK-004/TASK-006).
 *
 * The Pi session is a module-level stub injected through the provider's
 * `createSession` seam — no network, no real provider. The environment and
 * run-local session manager are real (temp-dir backed), so these tests also
 * cover the startup validation order: auth availability → model resolution →
 * session construction.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { defaultConfig, type YantraConfig } from '@yantra/core';
import { afterEach, describe, expect, it } from 'vitest';

import { PiAgentProvider, type PiSessionLike } from '../../../src/adapters/pi/provider.js';
import {
  AgentAuthUnavailableError,
  AgentModelNotFoundError,
  AgentSessionStartFailedError,
} from '../../../src/errors.js';
import type { AgentEvent, AgentSession, AgentSessionOptions } from '../../../src/provider/index.js';

// A value that core's sanitizer reliably redacts (`sk-` + 16+ alphanumerics).
// Deliberately digit-free so the earlier phone/SSN redactors can't split it.
const CREDENTIAL_CANARY = 'sk-canaryAbCdEfGhIjKlMnOpQr';

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true }).catch(() => undefined)),
  );
});

/** Controllable Pi session stub satisfying exactly the adapter's surface. */
class StubPiSession implements PiSessionLike {
  public readonly sessionId = 'pi-stub-session';
  public abortCount = 0;
  public disposeCount = 0;
  public promptScript: (emit: (event: AgentSessionEvent) => void) => Promise<void> | void = () =>
    undefined;

  private readonly listeners = new Set<(event: AgentSessionEvent) => void>();

  public subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public async prompt(
    _text: string,
    _options?: { expandPromptTemplates?: boolean },
  ): Promise<void> {
    await this.promptScript((event) => this.emit(event));
  }

  public abort(): Promise<void> {
    this.abortCount += 1;
    return Promise.resolve();
  }

  public dispose(): void {
    this.disposeCount += 1;
  }

  public emit(event: AgentSessionEvent): void {
    for (const listener of [...this.listeners]) {
      listener(event);
    }
  }
}

function makeAssistantMessage(stopReason: string, errorMessage?: string) {
  return {
    role: 'assistant' as const,
    content: [{ type: 'text' as const, text: 'done' }],
    api: 'openai-completions',
    provider: 'testprov',
    model: 'test-model',
    usage: {
      input: 100,
      output: 40,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 140,
      cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
    },
    stopReason,
    ...(errorMessage !== undefined ? { errorMessage } : {}),
    timestamp: 0,
  };
}

/**
 * The hermetic model registry these tests run against.
 *
 * `models.json` is a projection of `config.yaml`'s `models:` block, so the
 * registry is declared here rather than hand-written to disk — injecting it
 * also keeps the environment from projecting the developer's real config
 * into the sandbox.
 */
function hermeticConfig(): YantraConfig {
  return {
    ...defaultConfig(),
    models: [
      {
        id: 'test-model',
        provider: 'testprov',
        base_url: 'http://127.0.0.1:9/v1',
        api_key: null,
        input: ['text'],
      },
    ],
  };
}

interface Harness {
  readonly provider: PiAgentProvider;
  readonly stub: StubPiSession;
  readonly options: AgentSessionOptions;
  readonly dataDir: string;
  readonly capturedSessionOptions: () => unknown;
  readonly createSessionCalls: () => number;
}

/** Build a provider against a hermetic custom model with runtime-key auth. */
async function makeHarness(): Promise<Harness> {
  const dataDir = await makeTempDir('yantra-prov-data-');
  const runDir = await makeTempDir('yantra-prov-run-');
  const cwd = await makeTempDir('yantra-prov-cwd-');

  const stub = new StubPiSession();
  let captured: unknown;
  let calls = 0;
  const provider = new PiAgentProvider({
    dataDir,
    config: hermeticConfig(),
    resolveSecret: () => Promise.resolve('sk-runtimeKEY0123456789abcdef'),
    createSession: (sessionOptions) => {
      calls += 1;
      captured = sessionOptions;
      return Promise.resolve({ session: stub });
    },
  });

  const options: AgentSessionOptions = {
    runId: 'run-42',
    runDir,
    cwd,
    model: { provider: 'testprov', id: 'test-model' },
    auth: { mode: 'runtime-key', secretRef: 'testprov/api-key' },
    systemPrompt: 'agent-v1 prompt',
  };

  return {
    provider,
    stub,
    options,
    dataDir,
    capturedSessionOptions: () => captured,
    createSessionCalls: () => calls,
  };
}

function collectEvents(session: AgentSession): AgentEvent[] {
  const events: AgentEvent[] = [];
  session.subscribe((event) => events.push(event));
  return events;
}

describe('@no-llm PiAgentProvider.open — startup validation', () => {
  it('opens a session with built-ins disabled and only custom tools allowlisted', async () => {
    const harness = await makeHarness();
    const session = await harness.provider.open(harness.options);

    expect(session.id).toBe('pi-stub-session');
    expect(session.logPath).toContain(join(harness.options.runDir, 'agent'));

    const captured = harness.capturedSessionOptions() as {
      noTools?: string;
      tools?: string[];
      customTools?: unknown[];
      agentDir?: string;
    };
    expect(captured.noTools).toBe('all');
    expect(captured.tools).toEqual([]);
    expect(captured.customTools).toEqual([]);
    expect(captured.agentDir).toContain('pi');
  });

  it('unknown model id is a typed AGENT_MODEL_NOT_FOUND failure naming known models', async () => {
    const harness = await makeHarness();
    const attempt = harness.provider.open({
      ...harness.options,
      model: { provider: 'testprov', id: 'no-such-model' },
    });

    await expect(attempt).rejects.toBeInstanceOf(AgentModelNotFoundError);
    await expect(attempt).rejects.toMatchObject({
      code: 'AGENT_MODEL_NOT_FOUND',
      message: expect.stringContaining('test-model') as unknown,
    });
    expect(harness.createSessionCalls()).toBe(0);
  });

  it('missing credentials is a typed AGENT_AUTH_UNAVAILABLE failure and never constructs a session', async () => {
    const harness = await makeHarness();
    let factoryCalls = 0;
    const noAuthProvider = new PiAgentProvider({
      // Same pinned environment (model exists), but managed auth with nothing
      // seeded anywhere — no store entry, no runtime key, no env var.
      dataDir: harness.dataDir,
      createSession: () => {
        factoryCalls += 1;
        throw new Error('factory must be unreachable');
      },
    });

    const attempt = noAuthProvider.open({ ...harness.options, auth: { mode: 'managed' } });
    await expect(attempt).rejects.toBeInstanceOf(AgentAuthUnavailableError);
    await expect(attempt).rejects.toMatchObject({
      code: 'AGENT_AUTH_UNAVAILABLE',
      message: expect.stringContaining('docs/usage.md') as unknown,
    });
    expect(factoryCalls).toBe(0);
  });

  it('startup error messages never contain resolved key material', async () => {
    const harness = await makeHarness();
    // Worst case: session construction fails with an error that echoes the
    // resolved runtime key back. The typed error's message must redact it.
    const leakyProvider = new PiAgentProvider({
      dataDir: harness.dataDir,
      config: hermeticConfig(),
      resolveSecret: () => Promise.resolve(CREDENTIAL_CANARY),
      createSession: () => Promise.reject(new Error(`invalid key: ${CREDENTIAL_CANARY}`)),
    });

    const attempt = leakyProvider.open(harness.options);
    await expect(attempt).rejects.toBeInstanceOf(AgentSessionStartFailedError);
    const err = (await attempt.catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain(CREDENTIAL_CANARY);
    expect(err.message).toContain('[redacted-api-key]');
  });

  it('an invalid thinking level is a typed AGENT_SESSION_START_FAILED failure', async () => {
    const harness = await makeHarness();
    const attempt = harness.provider.open({
      ...harness.options,
      model: { ...harness.options.model, thinking: 'ultra-mega' },
    });

    await expect(attempt).rejects.toBeInstanceOf(AgentSessionStartFailedError);
    await expect(attempt).rejects.toMatchObject({ code: 'AGENT_SESSION_START_FAILED' });
  });
});

describe('@no-llm PiAgentProvider — event normalization', () => {
  it('maps each Pi event kind to the right AgentEvent with sanitized payloads', async () => {
    const harness = await makeHarness();
    harness.stub.promptScript = (emit) => {
      emit({
        type: 'tool_execution_start',
        toolCallId: 'call-1',
        toolName: 'status',
        args: { note: `credential ${CREDENTIAL_CANARY} embedded` },
      });
      emit({
        type: 'tool_execution_end',
        toolCallId: 'call-1',
        toolName: 'status',
        result: { content: [{ type: 'text', text: `ok ${CREDENTIAL_CANARY}` }], details: {} },
        isError: false,
      });
      emit({
        type: 'message_update',
        message: makeAssistantMessage('stop'),
        assistantMessageEvent: {
          type: 'text_delta',
          contentIndex: 0,
          delta: 'Hello world',
          partial: makeAssistantMessage('stop'),
        },
      } as AgentSessionEvent);
      emit({
        type: 'turn_end',
        message: makeAssistantMessage('stop'),
        toolResults: [],
      } as AgentSessionEvent);
      emit({
        type: 'agent_end',
        messages: [makeAssistantMessage('stop')],
        willRetry: false,
      } as AgentSessionEvent);
    };

    const session = await harness.provider.open(harness.options);
    const events = collectEvents(session);
    const result = await session.run('go');

    expect(events.map((event) => event.type)).toEqual([
      'tool_started',
      'tool_finished',
      'assistant_text',
      'turn_finished',
    ]);

    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(CREDENTIAL_CANARY);
    expect(serialized).toContain('[redacted-api-key]');

    expect(result.outcome).toBe('completed');
    expect(result.stopReason).toBe('stop');
    expect(result.usage).toEqual({ turns: 1, inputTokens: 100, outputTokens: 40, costUsd: 0.003 });
  });

  it('a failed provider turn emits a failed event and resolves outcome "failed"', async () => {
    const harness = await makeHarness();
    harness.stub.promptScript = (emit) => {
      emit({
        type: 'agent_end',
        messages: [makeAssistantMessage('error', 'upstream 529: overloaded')],
        willRetry: false,
      } as AgentSessionEvent);
    };

    const session = await harness.provider.open(harness.options);
    const events = collectEvents(session);
    const result = await session.run('go');

    expect(result.outcome).toBe('failed');
    expect(result.stopReason).toBe('error');
    expect(events).toEqual([
      expect.objectContaining({
        type: 'failed',
        error: expect.objectContaining({ code: 'AGENT_PROVIDER_UNAVAILABLE' }) as unknown,
      }),
    ]);
  });

  it('agent_end with willRetry pending is not a failure', async () => {
    const harness = await makeHarness();
    harness.stub.promptScript = (emit) => {
      emit({
        type: 'agent_end',
        messages: [makeAssistantMessage('error', 'transient')],
        willRetry: true,
      } as AgentSessionEvent);
      emit({
        type: 'agent_end',
        messages: [makeAssistantMessage('stop')],
        willRetry: false,
      } as AgentSessionEvent);
    };

    const session = await harness.provider.open(harness.options);
    const events = collectEvents(session);
    const result = await session.run('go');

    expect(result.outcome).toBe('completed');
    expect(events.filter((event) => event.type === 'failed')).toEqual([]);
  });

  it('a rejecting prompt() is normalized to a failed outcome, not a rejection', async () => {
    const harness = await makeHarness();
    harness.stub.promptScript = () => {
      throw new Error('socket hang up');
    };

    const session = await harness.provider.open(harness.options);
    const events = collectEvents(session);
    const result = await session.run('go');

    expect(result.outcome).toBe('failed');
    expect(events[0]).toMatchObject({
      type: 'failed',
      error: { code: 'AGENT_PROVIDER_UNAVAILABLE', message: 'socket hang up' },
    });
  });

  it('unknown or unmapped Pi events are ignored without throwing (drift tolerance)', async () => {
    const harness = await makeHarness();
    harness.stub.promptScript = (emit) => {
      emit({ type: 'agent_start' } as AgentSessionEvent);
      emit({ type: 'compaction_start', reason: 'threshold' } as AgentSessionEvent);
      emit({ type: 'some_future_event', payload: 1 } as unknown as AgentSessionEvent);
      emit({
        type: 'agent_end',
        messages: [makeAssistantMessage('stop')],
        willRetry: false,
      } as AgentSessionEvent);
    };

    const session = await harness.provider.open(harness.options);
    const events = collectEvents(session);
    const result = await session.run('go');

    expect(events).toEqual([]);
    expect(result.outcome).toBe('completed');
  });
});

describe('@no-llm PiAgentProvider — abort and close', () => {
  it('abort() during a run yields outcome "aborted"', async () => {
    const harness = await makeHarness();
    let releasePrompt: () => void = () => undefined;
    harness.stub.promptScript = () =>
      new Promise<void>((resolve) => {
        releasePrompt = resolve;
      });

    const session = await harness.provider.open(harness.options);
    const runPromise = session.run('go');

    await session.abort();
    expect(harness.stub.abortCount).toBe(1);
    releasePrompt();

    const result = await runPromise;
    expect(result.outcome).toBe('aborted');
    expect(result.stopReason).toBe('aborted');
  });

  it('double close() is safe and disposes the Pi session exactly once', async () => {
    const harness = await makeHarness();
    const session = await harness.provider.open(harness.options);

    await session.close();
    await session.close();

    expect(harness.stub.disposeCount).toBe(1);
  });

  it('abort() and run() after close() are safe/typed', async () => {
    const harness = await makeHarness();
    const session = await harness.provider.open(harness.options);
    await session.close();

    await expect(session.abort()).resolves.toBeUndefined();
    await expect(session.run('go')).rejects.toBeInstanceOf(AgentSessionStartFailedError);
  });
});
