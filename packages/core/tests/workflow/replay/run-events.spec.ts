// @no-llm
/**
 * Deterministic replay writes `run-events.jsonl` (FEAT-063 TASK-007): the
 * mirrored `TaskEvent` sequence, `artifact_saved` lines, and exactly one final
 * `run_outcome`, gap-free, for `run`, a failing `run`, and `resume`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ok, type RunEventRecordType, type WorkflowFile } from '@yantra/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import type { BrowserProvider, BrowserSession, Page } from '../../../src/browser/types.js';
import { ResourceBusyError } from '../../../src/locks/resource-lock.js';
import { readRunEvents } from '../../../src/run-events/reader.js';
import { RunEventStream } from '../../../src/run-events/stream.js';
import {
  RunOrchestrator,
  exitCodeFor,
  taskOutcomeForReplay,
} from '../../../src/workflow/replay/run-orchestrator.js';
import { LocalRunStore } from '../../../src/workflow/replay/run-store.js';
import type { WorkflowStore } from '../../../src/workflow/store.types.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const silent = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

function workflow(steps = 1, cookies: 'none' | 'auto' = 'auto'): WorkflowFile {
  return {
    version: 1,
    name: 'fixture',
    description: null,
    security_class: 'public',
    recorded_with: null,
    params: {},
    secrets: [],
    cookies,
    steps: Array.from({ length: steps }, (_, i) => ({
      id: `s${i + 1}`,
      verb: 'navigate' as const,
      scope: null,
      requires_confirmation: false,
      confirmation_description: null,
      expected_cost: null,
      consequence: null,
      url: `https://example.com/${i + 1}`,
    })),
    outputs: [],
    outputs_unredacted: false,
    _unrecorded_frames: [],
    _locators: {},
  } as WorkflowFile;
}

/** A browser whose page navigates instantly, or fails on the given URL. */
function fakeBrowser(failOn: string | null = null): BrowserProvider {
  const page = {
    goto: (url: string) =>
      url === failOn ? Promise.reject(new Error('connection reset')) : Promise.resolve(null),
    close: () => Promise.resolve(),
    url: () => 'about:blank',
  } as unknown as Page;
  const session = {
    id: 'session',
    chrome: { majorVersion: 150 },
    profilePath: join(tmpdir(), 'yantra-replay-events-profile'),
    newPage: () => Promise.resolve(page),
    newIsolatedPage: () => Promise.resolve(page),
    close: () => Promise.resolve(),
    on: () => undefined,
  } as unknown as BrowserSession;
  return { launch: () => Promise.resolve(session) } as unknown as BrowserProvider;
}

interface SetupOptions {
  readonly failOn?: string;
  readonly browser?: BrowserProvider;
  readonly steps?: number;
  readonly root?: string;
}

async function setup(options: SetupOptions = {}) {
  const root = options.root ?? (await mkdtemp(join(tmpdir(), 'yantra-replay-events-')));
  if (options.root === undefined) dirs.push(root);
  const runStore = new LocalRunStore(root);
  const store: WorkflowStore = {
    load: () => Promise.resolve(ok(workflow(options.steps))),
  } as unknown as WorkflowStore;
  const orchestrator = new RunOrchestrator({
    workflowStore: store,
    runStore,
    browserProvider: options.browser ?? fakeBrowser(options.failOn ?? null),
    keychain: {} as never,
    ethicsGate: { check: () => Promise.resolve() },
    logger: silent,
  });
  return { root, orchestrator, runStore };
}

const request = { workflowName: 'fixture', params: {}, budgets: {}, json: false, debug: false };

async function records(runDir: string): Promise<RunEventRecordType[]> {
  const out: RunEventRecordType[] = [];
  for await (const item of readRunEvents(join(runDir, 'run-events.jsonl'))) {
    if (item.status !== 'event') throw new Error(`unexpected ${item.status} line`);
    out.push(item.record);
  }
  return out;
}

const kinds = (rs: readonly RunEventRecordType[]): string[] => rs.map((r) => r.event.kind);

function expectGapFree(rs: readonly RunEventRecordType[]): void {
  expect(rs.map((r) => r.seq)).toEqual(rs.map((_, i) => i + 1));
}

function expectOneFinalOutcome(rs: readonly RunEventRecordType[]) {
  const outcomes = rs.filter((r) => r.event.kind === 'run_outcome');
  expect(outcomes).toHaveLength(1);
  expect(rs.at(-1)?.event.kind).toBe('run_outcome');
  return rs.at(-1)!.event;
}

describe('@no-llm replay run-events.jsonl', () => {
  it('a successful run logs the mirrored TaskEvents, its artifacts, then one fulfilled outcome', async () => {
    const { root, orchestrator } = await setup({ steps: 2 });
    const outcome = await orchestrator.run(request);
    const runDir = join(root, outcome.runId);
    const rs = await records(runDir);

    expectGapFree(rs);
    expect(expectOneFinalOutcome(rs)).toMatchObject({
      kind: 'run_outcome',
      run_id: outcome.runId,
      task_outcome: 'fulfilled',
      termination_reason: null,
      stop_detail: null,
      exit_code: 0,
      failure_class: null,
    });
    // The TaskEvent part is exactly events.jsonl, in order.
    const legacy = readFileSync(join(runDir, 'events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { kind: string });
    const mirrored = rs.filter((r) => legacy.some((e) => e.kind === r.event.kind));
    expect(mirrored.map((r) => r.event)).toEqual(legacy);
    expect(kinds(rs)).toEqual([
      'task_started',
      'step_started',
      'step_completed',
      'checkpoint_saved',
      'step_started',
      'step_completed',
      'checkpoint_saved',
      'task_completed',
      'artifact_saved',
      'artifact_saved',
      'artifact_saved',
      'run_outcome',
    ]);
    expect(
      rs
        .filter((r) => r.event.kind === 'artifact_saved')
        .map((r) => (r.event as { path: string }).path),
    ).toEqual(['outputs.json', 'report.md', 'report.json']);
  });

  it('records artifact kinds, media types and sizes', async () => {
    const { root, orchestrator } = await setup();
    const outcome = await orchestrator.run(request);
    const saved = (await records(join(root, outcome.runId))).filter(
      (r) => r.event.kind === 'artifact_saved',
    );

    expect(saved.map((r) => r.event)).toEqual([
      expect.objectContaining({ artifact_kind: 'output', media_type: 'application/json' }),
      expect.objectContaining({ artifact_kind: 'report', media_type: 'text/markdown' }),
      expect.objectContaining({ artifact_kind: 'report', media_type: 'application/json' }),
    ]);
    for (const r of saved) expect((r.event as { bytes: number }).bytes).toBeGreaterThan(0);
  });

  it('a failing step ends with run_outcome failed / exit 2', async () => {
    const { root, orchestrator } = await setup({ failOn: 'https://example.com/1' });
    const outcome = await orchestrator.run(request);
    const rs = await records(join(root, outcome.runId));

    expect(outcome.kind).toBe('failure');
    expectGapFree(rs);
    expect(expectOneFinalOutcome(rs)).toMatchObject({
      task_outcome: 'failed',
      exit_code: 2,
      failure_class: 'unexpected',
    });
    expect(kinds(rs)).toContain('task_failed');
  });

  it('resume continues the same log with task_resumed and a new outcome segment', async () => {
    const { root, orchestrator } = await setup({ failOn: 'https://example.com/2', steps: 2 });
    const first = await orchestrator.run(request);
    const runDir = join(root, first.runId);
    const before = await records(runDir);

    const { orchestrator: resumer } = await setup({ steps: 2, root });
    const resumed = await resumer.resume(first.runId);
    const after = await records(runDir);

    expectGapFree(after);
    expect(after.slice(0, before.length)).toEqual(before);
    const segment = after.slice(before.length);
    expect(segment[0]?.event.kind).toBe('task_resumed');
    expect(segment.filter((r) => r.event.kind === 'run_outcome')).toHaveLength(1);
    expect(segment.at(-1)?.event).toMatchObject({
      kind: 'run_outcome',
      run_id: first.runId,
      task_outcome: taskOutcomeForReplay(resumed),
      exit_code: exitCodeFor(resumed),
    });
  });

  it('writes the log with no stream injected, and closes it', async () => {
    const { root, orchestrator } = await setup();
    const outcome = await orchestrator.run(request);

    expect(existsSync(join(root, outcome.runId, 'run-events.jsonl'))).toBe(true);
  });

  it('commits a caller’s pre-open events first and delivers committed events to its subscriber', async () => {
    const { root, orchestrator } = await setup();
    const stream = new RunEventStream();
    const seen: (number | null)[] = [];
    stream.subscribe((d) => seen.push(d.seq));
    stream.emit({
      kind: 'goal_echo',
      display: 'goal: "x"',
      received_chars: 1,
      truncated: false,
      at: '2026-11-01T00:00:00.000Z',
    });

    const outcome = await orchestrator.run({ ...request, runEvents: stream });
    const rs = await records(join(root, outcome.runId));

    expect(rs[0]?.event.kind).toBe('goal_echo');
    expect(seen).toEqual(rs.map((r) => r.seq));
    expect(stream.closed).toBe(true);
  });

  it('a busy browser startup logs task_failed and, for an owned stream, a failed outcome with exit 3', async () => {
    const busy: BrowserProvider = {
      launch: () => Promise.reject(new ResourceBusyError({ kind: 'profile' }, null)),
    } as unknown as BrowserProvider;
    const { root, orchestrator } = await setup({ browser: busy });

    await expect(orchestrator.run(request)).rejects.toBeInstanceOf(ResourceBusyError);
    const [runId] = (await import('node:fs')).readdirSync(root);
    const rs = await records(join(root, runId!));

    expectGapFree(rs);
    expect(kinds(rs)).toEqual(['task_failed', 'run_outcome']);
    expect(rs.at(-1)?.event).toMatchObject({ task_outcome: 'failed', exit_code: 3 });
  });

  it('leaves a caller-supplied stream open (and outcome-free) when the run throws', async () => {
    const busy: BrowserProvider = {
      launch: () => Promise.reject(new ResourceBusyError({ kind: 'profile' }, null)),
    } as unknown as BrowserProvider;
    const { orchestrator } = await setup({ browser: busy });
    const stream = new RunEventStream();

    await expect(orchestrator.run({ ...request, runEvents: stream })).rejects.toThrow();
    expect(stream.opened).toBe(true);
    expect(stream.outcomeRecorded).toBe(false);
    stream.close();
  });
});
