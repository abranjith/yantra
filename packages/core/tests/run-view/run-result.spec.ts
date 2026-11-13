// @no-llm
/**
 * `readRunResult` (FEAT-066 TASK-004): every artifact is its own slot, so a
 * corrupt, legacy, missing or oversized file fails only itself.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RUN_RESULT_MAX_BYTES, RunResultView } from '@yantra/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  NODE_BOUNDED_READ_FS,
  readCapped,
  readHead,
  readTail,
  type BoundedReadFs,
} from '../../src/run-view/bounded-read.js';
import { ArtifactAccessError, RunNotFoundError } from '../../src/run-view/errors.js';
import {
  OUTPUTS_CAP_BYTES,
  enforceViewSize,
  normalizeManifest,
  readRunResult,
  type RunResultDeps,
} from '../../src/run-view/run-result.js';

import {
  agenticManifest,
  askBriefRun,
  buildRunDir,
  fixtureBrief,
  fixtureInstant,
  fixtureRunHealth,
  fixtureRunId,
  interruptedLegacyRun,
  legacyReportRun,
  startupFailureRun,
  templatedRun,
  workflowOutputsRun,
  type RunDirSpec,
} from './fixtures/build-run-dir.js';

let runsDir: string;

beforeEach(async () => {
  runsDir = await mkdtemp(join(tmpdir(), 'yantra-run-result-'));
});

afterEach(async () => {
  await rm(runsDir, { recursive: true, force: true });
});

function deps(overrides: Partial<RunResultDeps> = {}): RunResultDeps {
  return { runsDir, live: () => Promise.resolve(null), ...overrides };
}

async function read(spec: RunDirSpec, overrides: Partial<RunResultDeps> = {}) {
  await buildRunDir(runsDir, spec);
  const view = await readRunResult(spec.runId, deps(overrides));
  // Every view the reader returns is a valid protocol document.
  expect(RunResultView.safeParse(view).success).toBe(true);
  return view;
}

describe('documents', () => {
  it('reads an ask Brief run', async () => {
    const view = await read(askBriefRun(1));

    expect(view.mode).toBe('ask');
    expect(view.title).toBe('Fixture Brief');
    expect(view.task_outcome).toBe('fulfilled');
    expect(view.document.kind).toBe('brief');
    expect(view.document.kind === 'brief' && view.document.slot.state).toBe('ok');
    expect(view.run_health.state).toBe('ok');
    expect(view.notices_source).toBe('brief');
    expect(view.outputs).toBeNull();
    expect(view.report).toEqual({ exists: true, bytes: 20 });
  });

  it('reads a templated-document run', async () => {
    const view = await read(templatedRun(2));

    expect(view.document.kind).toBe('templated_report');
    expect(view.title).toBe('Weekly Report');
    expect(view.notices_source).toBe('document');
    expect(view.run_health).toEqual({ state: 'missing', path: 'run-health.json' });
  });

  it('marks a corrupt brief.json corrupt while every other slot is still read', async () => {
    const spec = askBriefRun(3);
    const view = await read({ ...spec, files: { ...spec.files, 'brief.json': '{"title": ' } });

    expect(view.document).toEqual({
      kind: 'brief',
      slot: { state: 'corrupt', path: 'brief.json', detail: 'not valid JSON' },
    });
    expect(view.run_health.state).toBe('ok');
    expect(view.report.exists).toBe(true);
    expect(view.title).toBe('ask');
  });

  it('marks a Brief that fails validation corrupt with a bounded, content-free detail', async () => {
    const spec = askBriefRun(4);
    const view = await read({
      ...spec,
      files: { ...spec.files, 'brief.json': fixtureBrief({ title: '', overview: 'SECRET-TEXT' }) },
    });

    const slot = view.document.kind === 'brief' ? view.document.slot : null;
    expect(slot?.state).toBe('corrupt');
    const detail = slot?.state === 'corrupt' ? slot.detail : '';
    expect(detail.length).toBeLessThanOrEqual(200);
    expect(detail).toContain('title');
    expect(detail).not.toContain('SECRET-TEXT');
  });

  it('marks a Brief with schema_version 0.1 unsupported with the found version', async () => {
    const spec = askBriefRun(5);
    const view = await read({
      ...spec,
      files: { ...spec.files, 'brief.json': fixtureBrief({ schema_version: '0.1' }) },
    });

    expect(view.document).toEqual({
      kind: 'brief',
      slot: { state: 'unsupported', path: 'brief.json', found_version: '0.1' },
    });
  });

  it('marks a brief.json over its cap too_large without reading it', async () => {
    const spec = askBriefRun(6);
    const readRange = vi.fn(NODE_BOUNDED_READ_FS.readRange);
    const fs: BoundedReadFs = { stat: NODE_BOUNDED_READ_FS.stat, readRange };
    const big = JSON.stringify(fixtureBrief({ overview: `${'x'.repeat(600 * 1024)} [1]` }));

    const view = await read(
      { ...spec, files: { ...spec.files, 'brief.json': big } },
      { readFs: fs },
    );

    expect(view.document.kind === 'brief' && view.document.slot.state).toBe('too_large');
    expect(readRange.mock.calls.some(([path]) => path.endsWith('brief.json'))).toBe(false);
  });
});

describe('runs without a document', () => {
  it('reads a workflow run with outputs and no synthesis', async () => {
    const view = await read(workflowOutputsRun(10));

    expect(view.mode).toBe('run');
    expect(view.document).toEqual({ kind: 'none' });
    expect(view.outputs).toEqual({
      state: 'ok',
      path: 'outputs.json',
      value: { balance: '1,024.00', statements: ['jan.pdf', 'feb.pdf'] },
    });
    expect(view.title).toBe('bank-statement');
    expect(view.notices_source).toBe('none');
  });

  it('never reads an outputs.json of 300 KiB: it is too_large', async () => {
    const spec = workflowOutputsRun(11);
    const readRange = vi.fn(NODE_BOUNDED_READ_FS.readRange);
    const fs: BoundedReadFs = { stat: NODE_BOUNDED_READ_FS.stat, readRange };

    const view = await read(
      { ...spec, files: { ...spec.files, 'outputs.json': { blob: 'y'.repeat(300 * 1024) } } },
      { readFs: fs },
    );

    expect(view.outputs).toMatchObject({ state: 'too_large', cap: OUTPUTS_CAP_BYTES });
    expect(readRange.mock.calls.some(([path]) => path.endsWith('outputs.json'))).toBe(false);
  });

  it('marks an outputs.json that is not an object corrupt', async () => {
    const spec = workflowOutputsRun(12);
    const view = await read({ ...spec, files: { ...spec.files, 'outputs.json': '[1,2]' } });
    expect(view.outputs?.state).toBe('corrupt');
  });

  it('reads a startup failure: agentError, no Brief', async () => {
    const view = await read(startupFailureRun(13));

    expect(view.document).toEqual({ kind: 'none' });
    expect(view.status).toBe('failed');
    expect(view.terminal).toEqual({
      source: 'manifest',
      failure_class: 'AGENT_AUTH_UNAVAILABLE',
      message: 'No credentials for anthropic. Run `yantra model auth`.',
    });
  });

  it('reads an interrupted legacy run', async () => {
    const view = await read(interruptedLegacyRun(14));
    expect(view).toMatchObject({
      execution_state: 'interrupted',
      task_outcome: 'failed',
      termination_reason: 'owner_lost',
      terminal: { source: 'manifest', termination_reason: 'owner_lost' },
    });
  });

  it('reads a legacy run with only manifest.json and report.md', async () => {
    const view = await read(legacyReportRun(15));

    expect(view.mode).toBe('run');
    expect(view.report.exists).toBe(true);
    expect(view.run_health.state).toBe('missing');
    expect(view.outputs?.state).toBe('missing');
    expect(view.terminal).toBeNull();
    expect(view.artifacts.map((item) => item.path)).toEqual(['manifest.json', 'report.md']);
  });
});

describe('the manifest', () => {
  it('still returns a view for a corrupt manifest', async () => {
    const runId = fixtureRunId(20);
    const view = await read({
      runId,
      manifest: '{ broken',
      files: { 'report.md': '# Report\n', 'run-health.json': fixtureRunHealth(runId) },
    });

    expect(view).toMatchObject({
      mode: 'unknown',
      title: runId,
      status: 'unknown',
      started_at: null,
      report: { exists: true },
      run_health: { state: 'ok' },
      notices_source: 'run_health',
    });
  });

  it('reads the ask/research pipeline manifest shape', () => {
    expect(
      normalizeManifest({
        type: 'research',
        query: 'best e-bikes',
        started_at: fixtureInstant(0),
        finished_at: fixtureInstant(3),
        status: 'ok',
      }),
    ).toMatchObject({ mode: 'research', intent: 'best e-bikes', durationMs: 3000, status: 'ok' });
  });

  it('takes the pipeline query as the title when there is no document', async () => {
    const runId = fixtureRunId(21, 'research');
    const view = await read({
      runId,
      manifest: {
        type: 'research',
        query: 'best e-bikes',
        started_at: fixtureInstant(21),
        status: 'ok',
      },
    });
    expect(view.title).toBe('best e-bikes');
  });

  it('drops words the protocol does not know instead of failing', () => {
    expect(
      normalizeManifest({ workflowName: 'w', taskOutcome: 'maybe', terminationReason: 'meh' }),
    ).toMatchObject({ taskOutcome: null, terminationReason: null, mode: 'run' });
    expect(normalizeManifest({ nothing: true })).toBeNull();
  });
});

describe('live flag', () => {
  it('passes the manifest status to the live probe and reports its answer', async () => {
    const live = vi.fn(() => Promise.resolve('unknown_owner' as const));
    const runId = fixtureRunId(30);
    const view = await read(
      { runId, manifest: agenticManifest(runId, 'ask', { status: 'running' }) },
      { live },
    );
    expect(live).toHaveBeenCalledWith(join(runsDir, runId), 'running');
    expect(view.live).toEqual({ state: 'unknown_owner' });
  });

  it('treats a failing probe as unknown_owner, never as running or dead', async () => {
    const view = await read(askBriefRun(31), { live: () => Promise.reject(new Error('EPERM')) });
    expect(view.live).toEqual({ state: 'unknown_owner' });
  });

  it('reconciles first, and a reconcile failure never fails the read', async () => {
    const reconcile = vi.fn(() => Promise.reject(new Error('locked')));
    await read(askBriefRun(32), { reconcile });
    expect(reconcile).toHaveBeenCalledOnce();
  });
});

describe('the inventory', () => {
  it('never lists lease.json, decisions or temp files', async () => {
    const spec = askBriefRun(40);
    const view = await read({
      ...spec,
      files: { ...spec.files, 'brief.json.tmp': '{}', 'plan.json': '{}' },
    });

    const paths = view.artifacts.map((item) => item.path);
    expect(paths).not.toContain('lease.json');
    expect(paths.some((path) => path.startsWith('decisions'))).toBe(false);
    expect(paths).not.toContain('brief.json.tmp');
    expect(paths).not.toContain('plan.json');
    expect(paths).toContain('brief.json');
  });
});

describe('errors', () => {
  it.each(['../x', 'not-a-run', '20260101T000000Z-a/b'])('refuses the run id %j', async (runId) => {
    await expect(readRunResult(runId, deps())).rejects.toBeInstanceOf(ArtifactAccessError);
  });

  it('is RunNotFoundError for a missing run', async () => {
    await expect(readRunResult(fixtureRunId(99), deps())).rejects.toBeInstanceOf(RunNotFoundError);
  });
});

describe('the size guard', () => {
  it('degrades the document slot first when the view would exceed 768 KiB', async () => {
    // A Brief under its own 512 KiB cap whose view, with outputs, crosses 768 KiB.
    const spec = askBriefRun(50);
    const view = await read(spec);
    const fat = {
      ...view,
      document: {
        kind: 'brief' as const,
        slot: {
          state: 'ok' as const,
          path: 'brief.json',
          value: {
            ...(view.document.kind === 'brief' && view.document.slot.state === 'ok'
              ? view.document.slot.value
              : {}),
            overview: 'z'.repeat(800 * 1024),
          },
        },
      },
    } as unknown as RunResultView;

    const guarded = enforceViewSize(fat);

    expect(guarded.document).toMatchObject({ kind: 'brief', slot: { state: 'too_large' } });
    expect(Buffer.byteLength(JSON.stringify(guarded))).toBeLessThanOrEqual(RUN_RESULT_MAX_BYTES);
  });

  it('then degrades the outputs', () => {
    const view = {
      document: { kind: 'none' },
      outputs: { state: 'ok', path: 'outputs.json', value: { blob: 'q'.repeat(800 * 1024) } },
      artifacts: [],
    } as unknown as RunResultView;

    const guarded = enforceViewSize(view);

    expect(guarded.outputs?.state).toBe('too_large');
  });

  it('leaves a small view untouched', async () => {
    const view = await read(askBriefRun(51));
    expect(enforceViewSize(view)).toBe(view);
  });
});

describe('bounded readers', () => {
  it('readCapped stats first and refuses a file over its cap without reading', async () => {
    const dir = await buildRunDir(runsDir, {
      runId: 'b',
      manifest: null,
      files: { 'a.txt': 'abcdef' },
    });
    const readRange = vi.fn(NODE_BOUNDED_READ_FS.readRange);
    const fs: BoundedReadFs = { stat: NODE_BOUNDED_READ_FS.stat, readRange };

    expect(await readCapped(join(dir, 'a.txt'), 5, fs)).toEqual({
      state: 'too_large',
      bytes: 6,
      cap: 5,
    });
    expect(readRange).not.toHaveBeenCalled();
    expect(await readCapped(join(dir, 'a.txt'), 6, fs)).toEqual({
      state: 'ok',
      text: 'abcdef',
      bytes: 6,
    });
    expect(await readCapped(join(dir, 'none.txt'), 6, fs)).toEqual({ state: 'missing' });
    expect(await readCapped(dir, 6, fs)).toEqual({ state: 'missing' });
  });

  it('readTail starts at a line boundary unless it covers the whole file', async () => {
    const dir = await buildRunDir(runsDir, {
      runId: 't',
      manifest: null,
      files: { 'a.jsonl': 'first line\nsecond\nthird\n' },
    });

    expect(await readTail(join(dir, 'a.jsonl'), 1024)).toBe('first line\nsecond\nthird\n');
    expect(await readTail(join(dir, 'a.jsonl'), 10)).toBe('third\n');
    expect(await readTail(join(dir, 'missing'), 10)).toBeNull();
  });

  it('readHead cuts an oversized file at its last complete line', async () => {
    const dir = await buildRunDir(runsDir, {
      runId: 'h',
      manifest: null,
      files: { 'r.md': 'line one\nline two\nline three\n' },
    });

    expect(await readHead(join(dir, 'r.md'), 14)).toEqual({
      text: 'line one\n',
      bytes: 29,
      truncated: true,
    });
    expect(await readHead(join(dir, 'r.md'), 100)).toMatchObject({ truncated: false, bytes: 29 });
    expect(await readHead(join(dir, 'missing.md'), 100)).toBeNull();
  });
});
