// @no-llm
/**
 * Agentic runs write their progress through the run's event stream (FEAT-063
 * TASK-011, and the agent half of TASK-009): pre-open warnings first, the
 * agent kinds in order, throttled budget snapshots, the Brief files, consent
 * waits, and one final `run_outcome` — while every connector callback still
 * receives exactly what it received before.
 */
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DefaultSanitizer,
  RunEventLogError,
  RunEventStream,
  ScriptRegistry,
  readRunEvents,
  type AgentBrowserController,
} from '@yantra/core';
import { LocalRunStore } from '@yantra/core/workflow/replay';
import type { ConfirmationRequest, RunEventDelivery, RunEventRecordType } from '@yantra/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentEvent } from '../../src/provider/types.js';
import type { AgentProgressEvent, AgentTaskConnector } from '../../src/runtime/connector.js';
import {
  runAgenticTask,
  type AgenticRunEnvironment,
  type AgenticTaskRequest,
} from '../../src/runtime/orchestrator.js';
import { exitCodeForAgenticOutcome, taskOutcomeOf } from '../../src/runtime/outcome.js';
import { resolveCommandTaskProfile } from '../../src/runtime/profiles.js';
import type { RunServices } from '../../src/runtime/run-services.js';
import { extractorReturning, searchServiceFor } from '../adapters/pi/tools/test-support.js';
import { FakeAgentProvider, type FakeSessionScript } from '../provider/fake-provider.js';

import { published } from './progress-test-support.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((r) => rm(r, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })),
  );
});

const BASE = Date.parse('2026-11-01T12:00:00.000Z');

function toolEvent(type: 'tool_started' | 'tool_finished', tool: string, at: number): AgentEvent {
  return type === 'tool_started'
    ? { type, tool, callId: `${tool}-${at}`, input: { url: 'x' }, at: new Date(at).toISOString() }
    : {
        type,
        tool,
        callId: `${tool}-${at}`,
        output: { status: 'ok' },
        isError: false,
        at: new Date(at).toISOString(),
      };
}

interface Fixture {
  readonly script: (clock: { advance(ms: number): number }) => FakeSessionScript;
  readonly goal?: string;
  readonly runEvents?: RunEventStream;
  readonly signal?: AbortSignal;
  readonly onServices?: (services: RunServices) => void;
}

async function run(fixture: Fixture) {
  const root = await mkdtemp(join(tmpdir(), 'yantra-agent-run-events-'));
  roots.push(root);
  let time = BASE;
  const clock = { advance: (ms: number) => (time += ms) };
  const provider = new FakeAgentProvider(fixture.script(clock));
  const events: AgentProgressEvent[] = [];
  const warnings: string[] = [];
  const connector: AgentTaskConnector = {
    interactive: false,
    emitAgentEvent: (e) => events.push(e),
    emitAgentWarning: (w) => warnings.push(w),
    renderAgentOutcome: () => undefined,
    requestConfirmation: () => Promise.resolve('denied'),
  };
  const environment: AgenticRunEnvironment = {
    browserController: { teardown: () => Promise.resolve() } as Pick<
      AgentBrowserController,
      'teardown'
    >,
    domain: {
      search: {
        service: searchServiceFor({ name: 'duckduckgo', search: () => Promise.resolve([]) }),
        resultCap: 3,
        fetchTop: 0,
      },
      fetch: {
        fetcher: { fetch: () => Promise.reject(new Error('unused')) },
        extractor: extractorReturning(null),
        ethics: { check: () => Promise.resolve() },
        allowedContentTypes: ['text/html'],
        maxContentBytes: 1024,
        captureThresholdBytes: 512,
      },
      script: { registry: new ScriptRegistry() },
      publish: { publish: () => Promise.reject(new Error('unused')) },
      browser: null,
      workflow: null,
      rank: null,
    },
  };
  const request: AgenticTaskRequest = {
    goal: fixture.goal ?? 'Read a fixture and report the result',
    profile: resolveCommandTaskProfile('do'),
    model: { provider: 'fixture', id: 'fixture-model' },
    auth: { mode: 'managed' },
    connector,
    ...(fixture.runEvents ? { runEvents: fixture.runEvents } : {}),
    ...(fixture.signal ? { signal: fixture.signal } : {}),
  };
  const outcome = await runAgenticTask(request, {
    runStore: new LocalRunStore(root),
    sanitizer: new DefaultSanitizer(),
    now: () => new Date(time),
    budgetNow: () => time,
    createEnvironment: () => Promise.resolve(environment),
    createProvider: (services) => {
      fixture.onServices?.(services);
      return provider;
    },
  });
  const records: RunEventRecordType[] = [];
  for await (const item of readRunEvents(join(outcome.runDir, 'run-events.jsonl'))) {
    if (item.status !== 'event') throw new Error(`unexpected ${item.status}`);
    records.push(item.record);
  }
  return { outcome, events, warnings, records, root };
}

const kinds = (rs: readonly RunEventRecordType[]) => rs.map((r) => r.event.kind);
const AGENT_KINDS = new Set([
  'recovery',
  'progress',
  'assistant_text',
  'tool_started',
  'tool_finished',
  'contract_declared',
  'capability_gap',
]);

/** Three tool rounds finishing 600 ms apart (+600, +1200, +1800 ms), then a publish at +1900. */
function scriptedPublish(clock: { advance(ms: number): number }): FakeSessionScript {
  return {
    onRun: async (_prompt, index, session) => {
      if (index > 0) return;
      session.emit({
        type: 'assistant_text',
        text: 'Looking.',
        at: new Date(clock.advance(0)).toISOString(),
      });
      for (const tool of ['web_search', 'web_fetch', 'web_fetch']) {
        session.emit(toolEvent('tool_started', tool, clock.advance(300)));
        session.emit(toolEvent('tool_finished', tool, clock.advance(300)));
      }
      await published(session);
      session.emit(toolEvent('tool_finished', 'result_publish', clock.advance(100)));
    },
  };
}

describe('@no-llm agentic run-events.jsonl', () => {
  it('logs the pre-open warning first, the agent kinds in order, then artifacts and one outcome', async () => {
    const { outcome, records, events, warnings } = await run({
      goal: 'Log in with password=hunter2xyz and read the dashboard',
      script: scriptedPublish,
    });

    expect(records.map((r) => r.seq)).toEqual(records.map((_, i) => i + 1));
    expect(records[0]?.event).toMatchObject({ kind: 'run_warning', source: 'agent' });
    expect(warnings).toHaveLength(1);
    // The agent kinds in the log are exactly what the connector received, in order.
    const logged = records.filter((r) => AGENT_KINDS.has(r.event.kind)).map((r) => r.event);
    expect(logged.map((e) => e.kind)).toEqual(events.map((e) => e.type));
    expect(logged[0]).toMatchObject({ kind: 'assistant_text', text: 'Looking.' });
    // The Brief files, then the outcome as the very last event.
    const saved = records.filter((r) => r.event.kind === 'artifact_saved').map((r) => r.event);
    expect(saved.map((e) => (e as { path: string }).path)).toEqual([
      'brief.json',
      'brief.md',
      'brief.html',
    ]);
    expect(records.filter((r) => r.event.kind === 'run_outcome')).toHaveLength(1);
    expect(records.at(-1)?.event).toMatchObject({
      kind: 'run_outcome',
      run_id: outcome.runId,
      task_outcome: taskOutcomeOf(outcome),
      termination_reason: outcome.terminationReason,
      exit_code: exitCodeForAgenticOutcome(outcome),
    });
  });

  it('throttles budget snapshots to one per second, plus one before the outcome', async () => {
    const { records } = await run({ script: scriptedPublish });
    const snapshots = records.filter((r) => r.event.kind === 'budget_snapshot');

    // Tool finishes land at +600, +1200, +1800 and +1900 ms: +600 passes, +1200
    // is within a second of it, +1800 passes, +1900 is throttled; one more is
    // taken before the outcome.
    expect(snapshots).toHaveLength(3);
    expect(snapshots[0]?.event).toMatchObject({
      dimensions: expect.arrayContaining([
        expect.objectContaining({ name: 'elapsed', unit: 'ms' }),
        expect.objectContaining({ name: 'tool_calls', unit: 'count' }),
        expect.objectContaining({ name: 'deliverable_captures', unit: 'count' }),
      ]),
    });
    const outcomeIndex = kinds(records).lastIndexOf('run_outcome');
    expect(kinds(records).slice(0, outcomeIndex).lastIndexOf('budget_snapshot')).toBeGreaterThan(
      kinds(records).lastIndexOf('tool_finished'),
    );
  });

  it('mirrors the TaskEvents into the log exactly as events.jsonl has them', async () => {
    const { outcome, records } = await run({ script: scriptedPublish });
    const legacy = (await readFile(join(outcome.runDir, 'events.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { kind: string });
    const mirrored = records
      .filter((r) => ['task_started', 'task_completed', 'task_failed'].includes(r.event.kind))
      .map((r) => r.event);

    expect(mirrored).toEqual(legacy);
  });

  it('with a CLI-supplied stream, renders through the stream only (no connector callbacks)', async () => {
    const stream = new RunEventStream();
    const local: RunEventDelivery[] = [];
    stream.subscribe((d) => local.push(d), { includeUncommitted: true });

    const { events, warnings, records } = await run({
      goal: 'Log in with password=hunter2xyz and read the dashboard',
      runEvents: stream,
      script: scriptedPublish,
    });

    expect(events).toEqual([]);
    expect(warnings).toEqual([]);
    expect(local.map((d) => d.event.kind)).toEqual(kinds(records));
    expect(stream.closed).toBe(true);
  });

  it.each([
    ['a failure (no publish)', {}],
    ['an abort', { abort: true }],
  ] as const)('ends %s with the matching run_outcome', async (_name, mode) => {
    const controller = new AbortController();
    const { outcome, records } = await run({
      ...('abort' in mode ? { signal: controller.signal } : {}),
      script: (clock) => ({
        onRun: (_prompt, _index, session) => {
          session.emit(toolEvent('tool_started', 'web_fetch', clock.advance(10)));
          if ('abort' in mode) controller.abort();
          session.emit(toolEvent('tool_finished', 'web_fetch', clock.advance(10)));
        },
      }),
    });

    expect(records.filter((r) => r.event.kind === 'run_outcome')).toHaveLength(1);
    expect(records.at(-1)?.event).toMatchObject({
      task_outcome: taskOutcomeOf(outcome),
      exit_code: exitCodeForAgenticOutcome(outcome),
    });
    if ('abort' in mode) expect(outcome.kind).toBe('aborted');
    else expect(outcome.kind).not.toBe('published');
  });

  it('ends a handoff with run_outcome handoff / exit 4', async () => {
    const { outcome, records } = await run({
      script: () => ({
        onRun: (_prompt, _index, session) => {
          session.emit({
            type: 'assistant_text',
            text: 'The site shows a CAPTCHA.',
            at: new Date(BASE).toISOString(),
          });
        },
      }),
    });

    expect(outcome.kind).toBe('handoff');
    expect(records.at(-1)?.event).toMatchObject({ task_outcome: 'handoff', exit_code: 4 });
  });

  it('records a non-interactive consent wait as raised → resolved timed_out by timeout', async () => {
    let services: RunServices | undefined;
    const request: ConfirmationRequest = {
      confirmation_id: '01J00000000000000000000000',
      run_id: 'run',
      step_id: 'click-1',
      action_kind: 'click',
      host: 'shop.example',
      description: 'Place the order',
      expected_cost: null,
      consequence: 'irreversible',
      requested_at: new Date(BASE).toISOString(),
      timeout_ms: 30_000,
    };
    const { records } = await run({
      onServices: (s) => {
        services = s;
      },
      script: () => ({
        onRun: async (_prompt, index) => {
          if (index === 0) await services!.confirmation!.gateway.request(request);
        },
      }),
    });
    const consent = records
      .filter((r) => r.event.kind.startsWith('intervention_'))
      .map((r) => r.event);

    expect(consent).toEqual([
      expect.objectContaining({
        kind: 'intervention_raised',
        intervention_id: request.confirmation_id,
        intervention_kind: 'confirmation',
        deadline_at: expect.any(String) as string,
      }),
      expect.objectContaining({
        kind: 'intervention_resolved',
        intervention_id: request.confirmation_id,
        decision: 'timed_out',
        decided_by: 'timeout',
      }),
    ]);
  });

  it('a startup failure before the run exists writes no log and still throws its error', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yantra-agent-run-events-'));
    roots.push(root);
    const connector: AgentTaskConnector = {
      interactive: false,
      emitAgentEvent: () => undefined,
      renderAgentOutcome: () => undefined,
      requestConfirmation: () => Promise.resolve('denied'),
    };

    await expect(
      runAgenticTask(
        {
          goal: 'find @{unclosed secret',
          model: { provider: 'fixture', id: 'fixture-model' },
          auth: { mode: 'managed' },
          connector,
        },
        { runStore: new LocalRunStore(root) },
      ),
    ).rejects.toThrow();
    expect(await readdir(root)).toEqual([]);
  });

  it('finalizes an unopenable log as a startup failure and rethrows it typed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yantra-agent-run-events-'));
    roots.push(root);
    const stream = new RunEventStream();
    vi.spyOn(stream, 'open').mockImplementation(() => {
      throw new RunEventLogError(
        'RUN_EVENT_LOG_OPEN_FAILED',
        'Could not open run-events.jsonl: EACCES',
      );
    });
    const connector: AgentTaskConnector = {
      interactive: false,
      emitAgentEvent: () => undefined,
      renderAgentOutcome: () => undefined,
      requestConfirmation: () => Promise.resolve('denied'),
    };

    await expect(
      runAgenticTask(
        {
          goal: 'Read a fixture',
          model: { provider: 'fixture', id: 'fixture-model' },
          auth: { mode: 'managed' },
          connector,
          runEvents: stream,
        },
        { runStore: new LocalRunStore(root) },
      ),
    ).rejects.toBeInstanceOf(RunEventLogError);
    const [runId] = await readdir(root);
    const manifest = JSON.parse(await readFile(join(root, runId!, 'manifest.json'), 'utf8')) as {
      status: string;
      agentError: { code: string };
    };
    expect(manifest.status).toBe('failed');
    expect(manifest.agentError.code).toBe('AGENT_RUN_EVENTS_UNAVAILABLE');
    expect(existsSync(join(root, runId!, 'run-events.jsonl'))).toBe(false);
  });
});
