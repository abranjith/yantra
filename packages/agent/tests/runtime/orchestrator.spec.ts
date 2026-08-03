import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DefaultSanitizer,
  parseTemplate,
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

import { createBriefPublisher } from '../../src/adapters/pi/tools/index.js';
import type { AgentEvent, AgentProvider, AgentRunResult } from '../../src/provider/index.js';
import type { AgentProgressEvent, AgentTaskConnector } from '../../src/runtime/connector.js';
import {
  DEFAULT_AGENT_BUDGETS,
  isRunFatalBudget,
  runAgenticTask,
  type AgenticRunEnvironment,
  type AgenticTaskRequest,
} from '../../src/runtime/orchestrator.js';
import type { AgenticTaskOutcome } from '../../src/runtime/outcome.js';
import type { EvidenceEntry, RunServices } from '../../src/runtime/run-services.js';
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
  readonly now?: () => Date;
  readonly budgetNow?: () => number;
  readonly template?: AgenticTaskRequest['template'];
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
      ...(options.template ? { template: options.template } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.budgets ? { budgets: options.budgets } : {}),
    },
    {
      runStore: new LocalRunStore(root),
      sanitizer: new DefaultSanitizer(),
      createEnvironment: () => Promise.resolve(environment),
      createProvider: () => options.provider,
      ...(options.now ? { now: options.now } : {}),
      ...(options.budgetNow ? { budgetNow: options.budgetNow } : {}),
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
        fetchTop: 3,
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
      rank: null,
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

/** A ledger entry as the web tools would record it during a run. */
function evidenceEntry(url: string, title: string): EvidenceEntry {
  return {
    url,
    finalUrl: null,
    title,
    excerpt: 'An excerpt from the final report.',
    fetchedAt: '2026-07-19T22:05:00.000Z',
    publishedAt: null,
    tool: 'web_search',
  };
}

describe('@no-llm runAgenticTask lifecycle', () => {
  it('does not assemble an unpublished draft in template mode', async () => {
    const parsed = parseTemplate(
      '# {{ title | text }}\n\n## Summary\n{{ summary }}\n\n{{ sources }}',
    );
    if (!parsed.isOk) throw new Error('fixture template did not parse');
    const provider = new FakeAgentProvider({
      eventsByRun: [
        [event('assistant_text', { text: 'A draft that must not be auto-assembled.' })],
        [],
      ],
      resultsByRun: [completed, completed],
    });
    const result = await fixture({
      provider,
      template: { manifest: parsed.value, source: 'saved', path: null, name: 'fixture' },
    });

    expect(result.outcome).toMatchObject({
      kind: 'failed',
      error: { code: 'AGENT_COMPLETION_MISSING' },
    });
    await expect(access(join(result.outcome.runDir, 'document.json'))).rejects.toThrow();
    await expect(access(join(result.outcome.runDir, 'document.md'))).rejects.toThrow();
    await expect(access(join(result.outcome.runDir, 'document.html'))).rejects.toThrow();
  });

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

  it('injects ambient date context from the run clock into the first user prompt', async () => {
    // Regression: small local models answered date-sensitive goals from their
    // training prior because nothing in the run told them the current date.
    // The instant renders in the host timezone, so the calendar date may be
    // July 19 or 20 depending on where the test runs — assert both.
    const provider = new FakeAgentProvider({ runResult: completed });

    await fixture({ provider, now: () => new Date('2026-07-19T12:00:00Z') });

    const firstPrompt = provider.sessions[0]?.runPrompts[0] ?? '';
    expect(firstPrompt).toContain(
      'Ambient context (authoritative; prefer these values over your training data):',
    );
    expect(firstPrompt).toMatch(/- current date: [A-Z][a-z]+day, 2026-07-(19|20)/);
    expect(firstPrompt).toMatch(/- timezone: \S+ \(UTC[+-]\d{2}:\d{2}\)/);
    expect(firstPrompt).toMatch(/- locale: \S+/);
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
    // Small local models cannot map "terminal publication capability" onto the
    // registered tool — the nudge must name result_publish and its payload key.
    expect(provider.sessions[0]?.runPrompts[1]).toContain('result_publish');
    expect(provider.sessions[0]?.runPrompts[1]).toContain('"brief"');
    // Regression: a model that asked the user to clarify a broad goal ("FIFA
    // World Cup") treated the vagueness as a sanctioned blocker and never
    // published. The nudge must close that escape hatch explicitly.
    expect(provider.sessions[0]?.runPrompts[1]).toMatch(/No user is available/i);
    expect(provider.sessions[0]?.runPrompts[1]).toMatch(/NOT a blocker/);
    expect(provider.sessions[0]?.runPrompts[1]).toMatch(/most reasonable interpretation/i);
  });

  it('recaps consulted sources in the nudge and freezes evidence tools (regression: post-nudge re-search changed the answer)', async () => {
    // Observed (run 20260720T005518Z-ask-335d987c): the generic nudge sent a
    // small model on a second web_search with a different query, and the
    // published brief contradicted the fresh evidence of the first search.
    let services: RunServices | undefined;
    const provider = new FakeAgentProvider({
      eventsByRun: [
        [event('assistant_text', { text: 'Spain won the 2026 final against Argentina.' })],
        [],
      ],
      onRun: (_prompt, runIndex) => {
        if (runIndex === 0) {
          services?.evidence.add(evidenceEntry('https://news.example.com/final', 'Final report'));
        }
      },
    });
    const root = await mkdtemp(join(tmpdir(), 'yantra-orchestrator-'));
    tempDirs.push(root);
    const connector = new RecordingConnector();
    const environment = buildEnvironment(vi.fn(() => Promise.resolve()));

    const outcome = await runAgenticTask(
      {
        goal: 'latest world cup news',
        model: { provider: 'fixture', id: 'fixture-model' },
        auth: { mode: 'managed' },
        connector,
      },
      {
        runStore: new LocalRunStore(root),
        sanitizer: new DefaultSanitizer(),
        createEnvironment: () => Promise.resolve(environment),
        createProvider: (runServices) => {
          services = runServices;
          return provider;
        },
      },
    );

    const nudge = provider.sessions[0]?.runPrompts[1] ?? '';
    expect(nudge).toContain('https://news.example.com/final');
    expect(nudge).toContain('Final report');
    expect(nudge).toMatch(/Do NOT call web_search or web_fetch again/);
    expect(nudge).toMatch(/attached to your published result automatically/i);
    // The draft answer is anchored so the nudge turn packages conclusion #1.
    expect(nudge).toMatch(/previous message is your draft answer/i);
    // The evidence branch drops the empty-ledger escape-hatch text.
    expect(nudge).not.toMatch(/genuinely impossible/i);
    expect(services?.evidencePhase.isFrozen()).toBe(true);
    // The stub publisher cannot publish, so the run still ends failed here;
    // the runtime-assembly path is covered by the next test.
    expect(outcome.kind).toBe('failed');
  });

  it('publishes a runtime-assembled Brief when the nudge turn still does not publish (regression: model declared publication impossible with evidence in context)', async () => {
    // Observed (run 20260720T004806Z-ask-1d48efc5): after one successful
    // web_search the model claimed sources "cannot be generated", and a run
    // holding a good draft plus good evidence ended AGENT_COMPLETION_MISSING.
    let services: RunServices | undefined;
    const provider = new FakeAgentProvider({
      eventsByRun: [
        [
          event('assistant_text', {
            text: 'Spain beat Argentina in the 2026 World Cup final.\nThe match ended 2-1.',
          }),
        ],
        [],
      ],
      onRun: (_prompt, runIndex) => {
        if (runIndex === 0) {
          services?.evidence.add(evidenceEntry('https://news.example.com/final', 'Final report'));
        }
      },
    });
    const root = await mkdtemp(join(tmpdir(), 'yantra-orchestrator-'));
    tempDirs.push(root);
    const connector = new RecordingConnector();
    const environment = buildEnvironment(vi.fn(() => Promise.resolve()));

    const outcome = await runAgenticTask(
      {
        goal: 'latest world cup news',
        model: { provider: 'fixture', id: 'fixture-model' },
        auth: { mode: 'managed' },
        connector,
      },
      {
        runStore: new LocalRunStore(root),
        sanitizer: new DefaultSanitizer(),
        createEnvironment: (context) =>
          Promise.resolve({
            ...environment,
            domain: {
              ...environment.domain,
              publish: createBriefPublisher(context.runDir, {
                taskId: context.taskId,
                runId: context.runId,
              }),
            },
          }),
        createProvider: (runServices) => {
          services = runServices;
          return provider;
        },
      },
    );

    expect(outcome).toMatchObject({ kind: 'published' });
    const brief = JSON.parse(await readFile(join(outcome.runDir, 'brief.json'), 'utf8')) as {
      title: string;
      overview: string;
      sources: { url: string; excerpt: string | null }[];
      metadata: Record<string, unknown>;
      notices: { source: string; kind: string }[];
    };
    expect(brief.title).toBe('Spain beat Argentina in the 2026 World Cup final.');
    expect(brief.overview).toContain('The match ended 2-1.');
    expect(brief.sources).toMatchObject([
      { url: 'https://news.example.com/final', excerpt: 'An excerpt from the final report.' },
    ]);
    // The assembly path is stamped honestly: fallback flag plus a notice.
    expect(brief.metadata).toMatchObject({
      synthesis: 'llm',
      deterministic_fallback_used: true,
    });
    expect(brief.notices).toMatchObject([{ source: 'runtime', kind: 'other' }]);
  });

  it('keeps AGENT_COMPLETION_MISSING when there is no draft answer to assemble', async () => {
    // Evidence without any draft text gives the runtime nothing to package:
    // the honest outcome is still a completion failure, never an empty Brief.
    let services: RunServices | undefined;
    const provider = new FakeAgentProvider({
      onRun: (_prompt, runIndex) => {
        if (runIndex === 0) {
          services?.evidence.add(evidenceEntry('https://news.example.com/final', 'Final report'));
        }
      },
    });
    const root = await mkdtemp(join(tmpdir(), 'yantra-orchestrator-'));
    tempDirs.push(root);
    const connector = new RecordingConnector();
    const environment = buildEnvironment(vi.fn(() => Promise.resolve()));

    const outcome = await runAgenticTask(
      {
        goal: 'latest world cup news',
        model: { provider: 'fixture', id: 'fixture-model' },
        auth: { mode: 'managed' },
        connector,
      },
      {
        runStore: new LocalRunStore(root),
        sanitizer: new DefaultSanitizer(),
        createEnvironment: (context) =>
          Promise.resolve({
            ...environment,
            domain: {
              ...environment.domain,
              publish: createBriefPublisher(context.runDir, {
                taskId: context.taskId,
                runId: context.runId,
              }),
            },
          }),
        createProvider: (runServices) => {
          services = runServices;
          return provider;
        },
      },
    );

    expect(outcome).toMatchObject({
      kind: 'failed',
      error: { code: 'AGENT_COMPLETION_MISSING' },
    });
    await expect(access(join(outcome.runDir, 'brief.json'))).rejects.toThrow();
  });

  it('surfaces the post-nudge blocker statement in the AGENT_COMPLETION_MISSING message', async () => {
    // The nudge invites the model to state its blocker when it cannot publish;
    // that statement must reach the failure message (and report.md), not be
    // discarded in favor of a bare completion code.
    const provider = new FakeAgentProvider({
      eventsByRun: [
        [event('assistant_text', { text: 'Here is a jumble of fixtures from many leagues.' })],
        [
          event('assistant_text', { text: 'The blocker is that the goal ' }),
          event('assistant_text', { text: 'was truncated out of my context.' }),
        ],
      ],
      runResult: completed,
    });

    const result = await fixture({ provider });

    expect(result.outcome).toMatchObject({
      kind: 'failed',
      error: { code: 'AGENT_COMPLETION_MISSING' },
    });
    const message = result.outcome.kind === 'failed' ? result.outcome.error.message : '';
    // Deltas of the post-nudge run are accumulated; pre-nudge chatter is not.
    expect(message).toContain(
      'Final agent message: The blocker is that the goal was truncated out of my context.',
    );
    expect(message).not.toContain('jumble of fixtures');
  });

  it('keeps the bare AGENT_COMPLETION_MISSING message when the model produced no text', async () => {
    const provider = new FakeAgentProvider({ runResult: completed });

    const result = await fixture({ provider });

    const message = result.outcome.kind === 'failed' ? result.outcome.error.message : '';
    expect(message).toBe(
      'The session ended without a successful result publication after one completion nudge.',
    );
  });

  it('bounds and whitespace-collapses a long post-nudge message excerpt', async () => {
    const longText = `lead-in\n\n${'x'.repeat(600)}`;
    const provider = new FakeAgentProvider({
      eventsByRun: [[], [event('assistant_text', { text: longText })]],
      runResult: completed,
    });

    const result = await fixture({ provider });

    const message = result.outcome.kind === 'failed' ? result.outcome.error.message : '';
    const excerpt = message.split('Final agent message: ')[1] ?? '';
    expect(excerpt.length).toBe(403); // 400 chars + '...'
    expect(excerpt.startsWith('lead-in x')).toBe(true); // newlines collapsed
    expect(excerpt.endsWith('...')).toBe(true);
  });

  it('persists the full unvalidated final response as result.md on completion-missing', async () => {
    // Regression (run 20260717T223950Z-research-03a436fd): the model answered
    // in full but never published; everything beyond a 400-char excerpt in the
    // failure message was discarded. The final response must survive as a file.
    const longAnswer = `# A full answer\n\n${'detail '.repeat(200)}end`;
    const provider = new FakeAgentProvider({
      eventsByRun: [[], [event('assistant_text', { text: longAnswer })]],
      runResult: completed,
    });

    const result = await fixture({ provider });

    expect(result.outcome).toMatchObject({
      kind: 'failed',
      error: { code: 'AGENT_COMPLETION_MISSING' },
    });
    const message = result.outcome.kind === 'failed' ? result.outcome.error.message : '';
    expect(message).toContain('saved to result.md');
    const saved = await readFile(join(result.outcome.runDir, 'result.md'), 'utf8');
    expect(saved).toBe(`${longAnswer}\n`);
  });

  it('writes no result.md when the model produced no final text', async () => {
    const provider = new FakeAgentProvider({ runResult: completed });

    const result = await fixture({ provider });

    const message = result.outcome.kind === 'failed' ? result.outcome.error.message : '';
    expect(message).not.toContain('result.md');
    await expect(access(join(result.outcome.runDir, 'result.md'))).rejects.toThrow();
  });

  it('records validation_error (not unexpected) for a completion-missing failure', async () => {
    // Regression: report.md showed AGENT_COMPLETION_MISSING while manifest and
    // events.jsonl classified the same failure as "unexpected".
    const provider = new FakeAgentProvider({ runResult: completed });

    const result = await fixture({ provider });

    const manifest = JSON.parse(
      await readFile(join(result.outcome.runDir, 'manifest.json'), 'utf8'),
    ) as { failureClass?: string };
    expect(manifest.failureClass).toBe('validation_error');
    const events = await readFile(join(result.outcome.runDir, 'events.jsonl'), 'utf8');
    expect(events).toContain('"failure_class":"validation_error"');
  });

  it('uses the finite shared duration, token, timeout, and retry defaults', async () => {
    const provider = new FakeAgentProvider({ runResult: completed });

    const result = await fixture({ provider });

    expect(result.outcome).toMatchObject({
      kind: 'failed',
      error: { code: 'AGENT_COMPLETION_MISSING' },
    });
    expect(DEFAULT_AGENT_BUDGETS).toMatchObject({
      wallClockMs: 900_000,
      maxProviderTokens: 2_000_000,
      perToolTimeoutMs: 180_000,
      toolRetries: 3,
    });
    expect(provider.sessions[0]?.abortCount).toBe(0);
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
      'wall clock',
      event('tool_finished', {
        callId: 'budget',
        tool: 'web_fetch',
        output: {
          status: 'error',
          error_code: 'BUDGET_EXHAUSTED',
          details: { budget_limit: 'wall-clock' },
        },
        isError: true,
      }),
    ],
    [
      'an unreported budget limit (fail safe)',
      event('tool_finished', {
        callId: 'budget',
        tool: 'web_fetch',
        output: { status: 'error', error_code: 'BUDGET_EXHAUSTED' },
        isError: true,
      }),
    ],
    [
      'provider token cap',
      event('turn_finished', { usage: { turns: 1, inputTokens: 6, outputTokens: 6 } }),
    ],
  ])('aborts and finalizes budget_exhausted for %s', async (label, budgetEvent) => {
    const provider = new FakeAgentProvider({ eventsOnRun: [budgetEvent] });
    const budgets = label === 'provider token cap' ? { maxProviderTokens: 10 } : undefined;

    const result = await fixture({ provider, ...(budgets ? { budgets } : {}) });

    expect(result.outcome.kind).toBe('budget_exhausted');
    expect(provider.sessions[0]?.abortCount).toBe(1);
    expect(provider.sessions[0]?.closeCount).toBe(1);
  });

  it.each(['wall-clock-soft', 'cumulative-bytes', 'navigations', 'hosts'])(
    'keeps the run alive so it can still publish when the %s budget is spent',
    async (limit) => {
      // Regression (run 20260801T222532Z-research-b99efc18): a spent tool budget
      // aborted the whole run, so a run holding twelve successfully fetched
      // sources was thrown away instead of publishing them. A budget bounds tool
      // use; only the wall clock ends the run itself.
      const provider = new FakeAgentProvider({
        eventsOnRun: [
          event('tool_finished', {
            callId: 'budget',
            tool: 'web_fetch',
            output: {
              status: 'error',
              error_code: 'BUDGET_EXHAUSTED',
              details: { budget_limit: limit },
            },
            isError: true,
          }),
        ],
        runResult: completed,
      });

      const result = await fixture({ provider });

      expect(result.outcome.kind).not.toBe('budget_exhausted');
      expect(provider.sessions[0]?.abortCount).toBe(0);
      // The run survives to the completion nudge — its chance to publish.
      expect(provider.sessions[0]?.runPrompts).toHaveLength(2);
    },
  );

  it('classifies the soft wall clock as non-fatal and the hard wall clock as fatal', () => {
    expect(isRunFatalBudget('wall-clock-soft')).toBe(false);
    expect(isRunFatalBudget('wall-clock')).toBe(true);
  });

  it('keeps pre-timeout evidence and publishes after one retryable tool timeout', async () => {
    let services: RunServices | undefined;
    const provider = new FakeAgentProvider({
      eventsByRun: [
        [
          event('assistant_text', { text: 'A supported draft from the first source.' }),
          event('tool_finished', {
            callId: 'timeout',
            tool: 'web_fetch',
            output: {
              status: 'error',
              error_code: 'TOOL_TIMEOUT',
              retryable: true,
            },
            isError: true,
          }),
        ],
        [
          event('tool_finished', {
            callId: 'publish',
            tool: 'result_publish',
            output: { status: 'ok', details: { brief_id: 'fixture' } },
            isError: false,
          }),
        ],
      ],
      resultsByRun: [completed, completed],
      onRun: async (_prompt, runIndex, session) => {
        if (runIndex === 0) {
          services?.evidence.add(evidenceEntry('https://news.example.com/before', 'First source'));
          return;
        }
        const runDir = join(session.logPath, '..', '..');
        await mkdir(runDir, { recursive: true });
        const brief = createBrief({
          task_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
          title: 'Published after a timeout',
          overview: 'The evidence gathered before the timeout was preserved. [1]',
          sources: [
            {
              n: 1,
              url: 'https://news.example.com/before',
              final_url: null,
              host: 'news.example.com',
              title: 'First source',
              excerpt: 'An excerpt from the final report.',
              fetched_at: '2026-07-19T22:05:00.000Z',
              published_at: null,
            },
          ],
        });
        await Promise.all([
          writeFile(join(runDir, 'brief.json'), JSON.stringify(brief), 'utf8'),
          writeFile(join(runDir, 'brief.md'), '# Published\n', 'utf8'),
          writeFile(join(runDir, 'brief.html'), '<h1>Published</h1>', 'utf8'),
        ]);
      },
    });

    const root = await mkdtemp(join(tmpdir(), 'yantra-orchestrator-'));
    tempDirs.push(root);
    const connector = new RecordingConnector();
    const environment = buildEnvironment(vi.fn(() => Promise.resolve()));
    const outcome = await runAgenticTask(
      {
        goal: 'latest news',
        model: { provider: 'fixture', id: 'fixture-model' },
        auth: { mode: 'managed' },
        connector,
      },
      {
        runStore: new LocalRunStore(root),
        sanitizer: new DefaultSanitizer(),
        createEnvironment: () => Promise.resolve(environment),
        createProvider: (runServices) => {
          services = runServices;
          return provider;
        },
      },
    );

    expect(outcome).toMatchObject({ kind: 'published' });
    expect(provider.sessions[0]?.abortCount).toBe(0);
    const brief = JSON.parse(await readFile(join(outcome.runDir, 'brief.json'), 'utf8')) as {
      sources: { url: string }[];
    };
    expect(brief.sources).toMatchObject([{ url: 'https://news.example.com/before' }]);
  });

  it('stops with a diagnostic failure after repeated identical tool failures (circuit breaker)', async () => {
    // Regression: a weak model that cannot form a valid call retried the same
    // impossible action until the per-tool budget was spent, failing for the
    // wrong reason. The breaker stops it early with an accurate message.
    const failure = (callId: string): AgentEvent =>
      event('tool_finished', {
        callId,
        tool: 'browser_click',
        output: { status: 'error', error_code: 'TOOL_EXECUTION_FAILED' },
        isError: true,
      });
    const provider = new FakeAgentProvider({ eventsByRun: [[failure('c1'), failure('c2')]] });

    const result = await fixture({ provider, budgets: { toolRetries: 1 } });

    expect(result.outcome).toMatchObject({
      kind: 'failed',
      error: { code: 'AGENT_TOOL_FAILED' },
    });
    const message = result.outcome.kind === 'failed' ? result.outcome.error.message : '';
    expect(message).toMatch(/repeatedly failed the same action/i);
    expect(message).toContain('browser_click');
    expect(message).toContain('TOOL_EXECUTION_FAILED');
    // The breaker interrupts the session and never reaches a completion nudge.
    expect(provider.sessions[0]?.abortCount).toBe(1);
    expect(provider.sessions[0]?.runPrompts).toHaveLength(1);
  });

  it('does not trip the repeated-failure breaker before the configured retry count', async () => {
    const failure = (callId: string): AgentEvent =>
      event('tool_finished', {
        callId,
        tool: 'browser_click',
        output: { status: 'error', error_code: 'TOOL_EXECUTION_FAILED' },
        isError: true,
      });
    const provider = new FakeAgentProvider({
      eventsByRun: [[failure('c1'), failure('c2'), failure('c3'), failure('c4')], []],
      runResult: completed,
    });

    const result = await fixture({ provider, budgets: { toolRetries: 5 } });

    expect(result.outcome).toMatchObject({
      kind: 'failed',
      error: { code: 'AGENT_COMPLETION_MISSING' },
    });
    expect(provider.sessions[0]?.abortCount).toBe(0);
    expect(provider.sessions[0]?.runPrompts).toHaveLength(2);
  });

  it('bounds repeated tool timeouts with the generic retry breaker', async () => {
    const timeout = (callId: string): AgentEvent =>
      event('tool_finished', {
        callId,
        tool: 'web_fetch',
        output: { status: 'error', error_code: 'TOOL_TIMEOUT', retryable: true },
        isError: true,
      });
    const provider = new FakeAgentProvider({ eventsByRun: [[timeout('a'), timeout('b')]] });

    const result = await fixture({ provider, budgets: { toolRetries: 1 } });

    expect(result.outcome).toMatchObject({
      kind: 'failed',
      error: { code: 'AGENT_TOOL_FAILED' },
    });
    const message = result.outcome.kind === 'failed' ? result.outcome.error.message : '';
    expect(message).toMatch(/repeatedly failed.*web_fetch.*TOOL_TIMEOUT/is);
    expect(message).not.toContain('per-tool-timeout');
  });

  it('lets the 3m × 4 timeout path reach the 12m wind-down and publish', async () => {
    let budgetTime = 0;
    const timeout = (callId: string): AgentEvent =>
      event('tool_finished', {
        callId,
        tool: 'web_fetch',
        output: { status: 'error', error_code: 'TOOL_TIMEOUT', retryable: true },
        isError: true,
      });
    const provider = new FakeAgentProvider({
      onRun: async (_prompt, runIndex, session) => {
        if (runIndex === 0) {
          for (let attempt = 0; attempt < 4; attempt += 1) {
            budgetTime += 3 * 60 * 1_000;
            session.emit(timeout(`timeout-${attempt}`));
          }
          session.emit(
            event('tool_finished', {
              callId: 'soft-stop',
              tool: 'web_fetch',
              output: {
                status: 'error',
                error_code: 'BUDGET_EXHAUSTED',
                details: { budget_limit: 'wall-clock-soft' },
              },
              isError: true,
            }),
          );
          return;
        }
        const runDir = join(session.logPath, '..', '..');
        const brief = createBrief({
          task_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
          title: 'Partial result',
          overview: 'Published at the soft deadline.',
        });
        await Promise.all([
          writeFile(join(runDir, 'brief.json'), JSON.stringify(brief), 'utf8'),
          writeFile(join(runDir, 'brief.md'), '# Partial result\n', 'utf8'),
          writeFile(join(runDir, 'brief.html'), '<h1>Partial result</h1>', 'utf8'),
        ]);
        session.emit(
          event('tool_finished', {
            callId: 'publish',
            tool: 'result_publish',
            output: { status: 'ok', details: { brief_id: brief.brief_id } },
            isError: false,
          }),
        );
      },
      resultsByRun: [completed, completed],
    });

    const result = await fixture({
      provider,
      budgetNow: () => budgetTime,
      budgets: {
        wallClockMs: 15 * 60 * 1_000,
        perToolTimeoutMs: 3 * 60 * 1_000,
        toolRetries: 3,
      },
    });

    expect(budgetTime).toBe(12 * 60 * 1_000);
    expect(result.outcome.kind).toBe('published');
    expect(provider.sessions[0]?.abortCount).toBe(0);
  });

  it('does not trip the breaker when a success interrupts the failure streak', async () => {
    const fail = (id: string): AgentEvent =>
      event('tool_finished', {
        callId: id,
        tool: 'browser_click',
        output: { status: 'error', error_code: 'TOOL_EXECUTION_FAILED' },
        isError: true,
      });
    const ok = (id: string): AgentEvent =>
      event('tool_finished', {
        callId: id,
        tool: 'browser_observe',
        output: { status: 'ok' },
        isError: false,
      });
    const provider = new FakeAgentProvider({
      // Two failures, a success (resets the streak), then two more: with two
      // retries allowed, neither streak reaches the third failing attempt.
      eventsByRun: [[fail('a'), fail('b'), ok('d'), fail('e'), fail('f')], []],
      runResult: completed,
    });

    const result = await fixture({ provider, budgets: { toolRetries: 2 } });

    expect(result.outcome).toMatchObject({
      kind: 'failed',
      error: { code: 'AGENT_COMPLETION_MISSING' },
    });
    expect(provider.sessions[0]?.runPrompts).toHaveLength(2);
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
