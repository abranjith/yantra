import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DefaultSanitizer,
  ScriptRegistry,
  type AgentBrowserController,
  type ContentFetcher,
  type EthicsGate,
  type Extractor,
  type SearchProvider,
} from '@yantra/core';
import { LocalRunStore } from '@yantra/core/workflow/replay';
import { createBrief, type ConfirmationRequest } from '@yantra/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentEvent, AgentProvider, AgentRunResult } from '../../src/provider/index.js';
import type { AgentProgressEvent, AgentTaskConnector } from '../../src/runtime/connector.js';
import {
  runAgenticTask,
  type AgenticRunEnvironment,
  type AgenticTaskRequest,
} from '../../src/runtime/orchestrator.js';
import type { AgenticTaskOutcome } from '../../src/runtime/outcome.js';
import { FakeAgentProvider } from '../provider/fake-provider.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })),
  );
});

class RecordingConnector implements AgentTaskConnector {
  public readonly interactive = true;
  public readonly events: AgentProgressEvent[] = [];
  public readonly outcomes: AgenticTaskOutcome[] = [];

  public requestConfirmation(
    _request: ConfirmationRequest,
    _signal: AbortSignal,
  ): Promise<'granted'> {
    return Promise.resolve('granted');
  }

  public emitAgentEvent(event: AgentProgressEvent): void {
    this.events.push(event);
  }

  public renderAgentOutcome(outcome: AgenticTaskOutcome): void {
    this.outcomes.push(outcome);
  }
}

async function fixture(options: {
  readonly provider: AgentProvider;
  readonly signal?: AbortSignal;
  readonly budgets?: AgenticTaskRequest['budgets'];
}): Promise<{
  readonly outcome: AgenticTaskOutcome;
  readonly connector: RecordingConnector;
  readonly teardown: ReturnType<typeof vi.fn>;
}> {
  const root = await mkdtemp(join(tmpdir(), 'yantra-orchestrator-'));
  tempDirs.push(root);
  const connector = new RecordingConnector();
  const teardown = vi.fn(() => Promise.resolve());
  const environment = buildEnvironment(teardown);
  const outcome = await runAgenticTask(
    {
      goal: 'Complete the fixture task',
      model: { provider: 'fixture', id: 'fixture-model' },
      auth: { mode: 'managed' },
      connector,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.budgets ? { budgets: options.budgets } : {}),
    },
    {
      runStore: new LocalRunStore(root),
      sanitizer: new DefaultSanitizer(),
      createEnvironment: () => Promise.resolve(environment),
      createProvider: () => options.provider,
    },
  );
  return { outcome, connector, teardown };
}

function buildEnvironment(teardown: ReturnType<typeof vi.fn>): AgenticRunEnvironment {
  const searchProvider: SearchProvider = {
    name: 'duckduckgo',
    search: () => Promise.resolve([]),
  };
  const fetcher: ContentFetcher = { fetch: () => Promise.reject(new Error('unused')) };
  const extractor: Extractor = { extract: () => Promise.resolve(null) };
  const ethics: EthicsGate = { check: () => Promise.resolve() };
  return {
    browserController: { teardown } as unknown as Pick<AgentBrowserController, 'teardown'>,
    domain: {
      search: {
        resolveProvider: () => Promise.resolve({ isOk: true, value: searchProvider }),
        resultCap: 5,
      },
      fetch: {
        fetcher,
        extractor,
        ethics,
        allowedContentTypes: ['text/html'],
        maxContentBytes: 1024,
        captureThresholdBytes: 512,
      },
      script: { registry: new ScriptRegistry() },
      publish: {
        publish: () =>
          Promise.resolve({
            isOk: false,
            error: new Error('unused publisher'),
          } as never),
      },
      browser: null,
      workflow: null,
    },
  };
}

const completed: AgentRunResult = {
  outcome: 'completed',
  stopReason: 'stop',
  usage: { turns: 1 },
};

function event(type: AgentEvent['type'], fields: Record<string, unknown> = {}): AgentEvent {
  return { type, at: '2026-07-14T12:00:00.000Z', ...fields } as AgentEvent;
}

describe('@no-llm runAgenticTask lifecycle', () => {
  it('returns published, fans every seam event to audit and connector, and tears down once', async () => {
    const provider = new FakeAgentProvider({
      eventsOnRun: [
        event('assistant_text', { text: 'Working safely.' }),
        event('tool_started', {
          callId: 'c1',
          tool: 'result_publish',
          input: { brief: 'bounded' },
        }),
        event('tool_finished', {
          callId: 'c1',
          tool: 'result_publish',
          output: { status: 'ok', details: { brief_id: 'fixture' } },
          isError: false,
        }),
      ],
      onRun: async (_prompt, runIndex, session) => {
        if (runIndex !== 0) return;
        const runDir = join(session.logPath, '..', '..');
        await mkdir(runDir, { recursive: true });
        const brief = createBrief({
          task_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
          title: 'Fixture result',
          overview: 'The fixture completed.',
        });
        await Promise.all([
          writeFile(join(runDir, 'brief.json'), JSON.stringify(brief), 'utf8'),
          writeFile(join(runDir, 'brief.md'), '# Fixture result\n', 'utf8'),
          writeFile(join(runDir, 'brief.html'), '<h1>Fixture result</h1>', 'utf8'),
        ]);
      },
    });

    const result = await fixture({ provider });
    const session = provider.sessions[0]!;
    const toolAudit = await readFile(join(result.outcome.runDir, 'tool-calls.jsonl'), 'utf8');

    expect(result.outcome.kind).toBe('published');
    expect(session.runPrompts).toHaveLength(1);
    expect(session.closeCount).toBe(1);
    expect(result.teardown).toHaveBeenCalledTimes(1);
    expect(result.connector.events.map((item) => item.type)).toEqual([
      'assistant_text',
      'tool_started',
      'tool_finished',
    ]);
    expect(toolAudit.trim().split('\n')).toHaveLength(2);
    expect(result.connector.outcomes).toEqual([result.outcome]);
  });

  it('issues exactly one structured nudge and returns AGENT_COMPLETION_MISSING', async () => {
    const provider = new FakeAgentProvider({ runResult: completed });

    const result = await fixture({ provider });

    expect(result.outcome).toMatchObject({
      kind: 'failed',
      error: { code: 'AGENT_COMPLETION_MISSING' },
    });
    expect(provider.sessions[0]?.runPrompts).toHaveLength(2);
    expect(provider.sessions[0]?.runPrompts[1]).toMatch(/no validated result has been published/i);
  });

  it('maps a provider failure event to failed without a completion nudge', async () => {
    const provider = new FakeAgentProvider({
      eventsOnRun: [
        event('failed', {
          error: { code: 'AGENT_PROVIDER_UNAVAILABLE', message: 'fixture provider failed' },
        }),
      ],
      runResult: { outcome: 'failed', stopReason: 'error', usage: { turns: 1 } },
    });

    const result = await fixture({ provider });

    expect(result.outcome).toMatchObject({
      kind: 'failed',
      error: { code: 'AGENT_PROVIDER_UNAVAILABLE' },
    });
    expect(provider.sessions[0]?.runPrompts).toHaveLength(1);
  });

  it('finalizes a structured report after an injected provider crash', async () => {
    const provider = new FakeAgentProvider({
      onRun: () => {
        throw new Error('fixture provider crashed');
      },
    });

    const result = await fixture({ provider });
    const report = await readFile(join(result.outcome.runDir, 'report.md'), 'utf8');

    expect(result.outcome).toMatchObject({
      kind: 'failed',
      error: { code: 'AGENT_TOOL_FAILED' },
    });
    expect(report).toContain('AGENT_TOOL_FAILED');
    expect(provider.sessions[0]?.closeCount).toBe(1);
    expect(result.teardown).toHaveBeenCalledTimes(1);
  });

  it('drains a provider event storm and still terminates cleanly', async () => {
    const storm = Array.from({ length: 500 }, (_, index) =>
      event('assistant_text', { text: `bounded progress ${index}` }),
    );
    const provider = new FakeAgentProvider({
      eventsOnRun: [
        ...storm,
        event('failed', {
          error: { code: 'AGENT_PROVIDER_UNAVAILABLE', message: 'storm fixture stopped' },
        }),
      ],
      runResult: { outcome: 'failed', stopReason: 'error', usage: { turns: 1 } },
    });

    const result = await fixture({ provider });

    expect(result.outcome.kind).toBe('failed');
    expect(result.connector.events).toHaveLength(500);
    expect(provider.sessions[0]?.closeCount).toBe(1);
    expect(result.teardown).toHaveBeenCalledTimes(1);
  });

  it('returns a precise handoff after the bounded nudge when a tool reports a site blocker', async () => {
    const provider = new FakeAgentProvider({
      eventsOnRun: [
        event('tool_finished', {
          callId: 'c1',
          tool: 'browser_navigate',
          output: {
            status: 'error',
            error_code: 'ETHICS_BLOCKED',
            details: { handoff: true },
          },
          isError: true,
        }),
      ],
    });

    const result = await fixture({ provider });

    expect(result.outcome).toMatchObject({ kind: 'handoff', blocker: 'error: ETHICS_BLOCKED' });
    expect(provider.sessions[0]?.runPrompts).toHaveLength(2);
  });

  it.each([
    [
      'tool-call/host/navigation/byte cap',
      event('tool_finished', {
        callId: 'budget',
        tool: 'web_fetch',
        output: { status: 'error', error_code: 'BUDGET_EXHAUSTED' },
        isError: true,
      }),
    ],
    [
      'per-tool timeout',
      event('tool_finished', {
        callId: 'timeout',
        tool: 'web_fetch',
        output: { status: 'error', error_code: 'TOOL_TIMEOUT' },
        isError: true,
      }),
    ],
    [
      'provider token cap',
      event('turn_finished', { usage: { turns: 1, inputTokens: 6, outputTokens: 6 } }),
    ],
    ['provider cost cap', event('turn_finished', { usage: { turns: 1, costUsd: 2 } })],
  ])('aborts and finalizes budget_exhausted for %s', async (label, budgetEvent) => {
    const provider = new FakeAgentProvider({ eventsOnRun: [budgetEvent] });
    const budgets =
      label === 'provider token cap'
        ? { maxProviderTokens: 10 }
        : label === 'provider cost cap'
          ? { maxProviderCostUsd: 1 }
          : undefined;

    const result = await fixture({ provider, ...(budgets ? { budgets } : {}) });

    expect(result.outcome.kind).toBe('budget_exhausted');
    expect(provider.sessions[0]?.abortCount).toBe(1);
    expect(provider.sessions[0]?.closeCount).toBe(1);
  });

  it('maps an already-aborted caller signal to aborted and still tears down once', async () => {
    const controller = new AbortController();
    controller.abort('ctrl-c');
    const provider = new FakeAgentProvider();

    const result = await fixture({ provider, signal: controller.signal });

    expect(result.outcome.kind).toBe('aborted');
    expect(provider.sessions[0]?.abortCount).toBe(1);
    expect(provider.sessions[0]?.closeCount).toBe(1);
    expect(result.teardown).toHaveBeenCalledTimes(1);
  });
});
