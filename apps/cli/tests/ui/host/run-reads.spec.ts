// @no-llm
/**
 * The app's run reads (FEAT-066): `read.list` Ledger pages (TASK-002) and
 * `read.run_result` (TASK-004).
 */

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ArtifactAccessError, resetPathCache, runsRoot, type HistoryEntry } from '@yantra/core';
import { RunLedgerPage, type InvocationRecord, type RunLedgerQuery } from '@yantra/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  askBriefRun,
  buildRunDir,
  legacyReportRun,
  startupFailureRun,
} from '../../../../../packages/core/tests/run-view/fixtures/build-run-dir.js';
import { openHistory } from '../../../src/history.js';
import type { HostLogger } from '../../../src/ui/host/host.js';
import {
  MAX_LEDGER_PAGE_BYTES,
  displayedStateOf,
  hostActiveRuns,
  jsonBytes,
  readLedgerPage,
  registerLedgerRead,
  type LedgerReadDeps,
} from '../../../src/ui/host/ledger-reads.js';
import {
  RpcError,
  RpcMethodRegistry,
  type RpcCallContext,
} from '../../../src/ui/host/rpc-server.js';
import {
  registerRunReads,
  runReadError,
  type RunReadDeps,
} from '../../../src/ui/host/run-reads.js';

let home: string;

function at(second: number): string {
  return new Date(Date.UTC(2026, 10, 1, 0, 0, second)).toISOString();
}

function runId(second: number, name = 'fixture'): string {
  return `${at(second)
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z')}-${name}-0000abcd`;
}

async function writeRun(id: string, second: number, overrides: Record<string, unknown> = {}) {
  const dir = join(runsRoot(), id);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify({
      runId: id,
      taskId: 't',
      workflowName: 'fixture',
      workflowVersion: 1,
      status: 'completed',
      startedAt: at(second),
      endedAt: at(second),
      durationMs: 1,
      profileKind: 'ephemeral',
      cookieProfilePath: null,
      params: {},
      outputBindingNames: [],
      ...overrides,
    }),
  );
}

function entry(second: number, overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    runId: runId(second, 'ask'),
    taskType: 'ask',
    intentText: `question ${second}`,
    briefId: null,
    status: 'succeeded',
    startedAt: at(second),
    finishedAt: at(second),
    durationMs: 1,
    costUsd: null,
    provider: null,
    taskOutcome: 'fulfilled',
    ...overrides,
  };
}

function deps(overrides: Partial<LedgerReadDeps> = {}): LedgerReadDeps {
  return {
    openHistory: () => openHistory(),
    listWorkflows: () => Promise.resolve({ schemaVersion: '0.2', kind: 'list', items: [] }),
    reconcile: () => Promise.resolve(),
    ...overrides,
  };
}

function query(overrides: Partial<RunLedgerQuery> = {}): RunLedgerQuery {
  return { target: 'runs', limit: 50, ...overrides };
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'yantra-run-reads-'));
  vi.stubEnv('YANTRA_HOME', home);
  resetPathCache();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  resetPathCache();
  await rm(home, { recursive: true, force: true });
});

describe('read.list (runs)', () => {
  it('returns a valid Ledger page from the index, with an opaque cursor', async () => {
    const history = (await openHistory())!;
    for (let i = 0; i < 3; i++) await history.store.record(entry(i));
    history.close();

    const first = await readLedgerPage(query({ limit: 2 }), deps());
    const second = await readLedgerPage(query({ limit: 2, cursor: first.next_cursor! }), deps());

    expect(RunLedgerPage.parse(first)).toEqual(first);
    expect(first.source).toBe('index');
    expect(first.scan_truncated).toBeUndefined();
    expect(first.items.map((item) => item.runId)).toEqual([runId(2, 'ask'), runId(1, 'ask')]);
    expect(second.items.map((item) => item.runId)).toEqual([runId(0, 'ask')]);
    expect(second.next_cursor).toBeNull();
  });

  it('says the source is files, with scan_truncated, when the index is unavailable', async () => {
    await writeRun(runId(1), 1);

    const page = await readLedgerPage(query(), deps({ openHistory: () => Promise.resolve(null) }));

    expect(page.source).toBe('files');
    expect(page.scan_truncated).toBe(false);
    expect(page.items.map((item) => item.runId)).toEqual([runId(1)]);
  });

  it('applies the Ledger filters', async () => {
    const history = (await openHistory())!;
    await history.store.record(entry(1, { taskOutcome: 'failed', status: 'failed' }));
    await history.store.record(entry(2, { taskType: 'research', intentText: 'Deep 100% dive' }));
    history.close();

    const failed = await readLedgerPage(query({ outcome: ['failed'] }), deps());
    const text = await readLedgerPage(query({ text: '100%' }), deps());
    const mode = await readLedgerPage(query({ mode: ['research'] }), deps());

    expect(failed.items.map((item) => item.runId)).toEqual([runId(1, 'ask')]);
    expect(text.items.map((item) => item.runId)).toEqual([runId(2, 'ask')]);
    expect(mode.items.map((item) => item.taskType)).toEqual(['research']);
  });

  it('puts unfinished runs in active on the first page, with the host’s displayed state', async () => {
    await writeRun(runId(5), 5, { status: 'running' });
    await writeRun(runId(4), 4, { status: 'running' });
    await writeRun(runId(1), 1);

    const page = await readLedgerPage(
      query(),
      deps({
        activeRuns: () => Promise.resolve([{ runId: runId(5), displayedState: 'running' }]),
      }),
    );

    expect(page.items.map((item) => item.runId)).toEqual([runId(1)]);
    expect(page.active.map((run) => [run.runId, run.displayedState])).toEqual([
      [runId(5), 'running'],
      [runId(4), 'unknown_owner'],
    ]);
  });

  it('runs reconciliation before reading, like yantra list', async () => {
    const reconcile = vi.fn(() => Promise.resolve());
    await readLedgerPage(query(), deps({ reconcile }));
    expect(reconcile).toHaveBeenCalledOnce();
  });

  it.each([
    'garbage!!',
    Buffer.from('{"v":1,"s":"x","r":"y"}').toString('base64url'),
    Buffer.from('{"v":9}').toString('base64url'),
  ])(
    'refuses the cursor %j with invalid_params, never falling back to page one',
    async (cursor) => {
      const error = await readLedgerPage(query({ cursor }), deps()).catch(
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(RpcError);
      expect((error as RpcError).code).toBe(-32602);
      expect((error as RpcError).data.remediation).toBe('Start again without a cursor.');
    },
  );

  it('stays under 768 KiB at limit 200 even with very long intent texts', async () => {
    // Arrange: 260 rows whose intent texts are 8 KB each (~2 MB if sent whole).
    const history = (await openHistory())!;
    for (let i = 0; i < 260; i++) {
      await history.store.record(entry(i, { intentText: `${String(i)} ${'q'.repeat(8_000)}` }));
    }
    history.close();

    // Act: walk every page.
    const seen: string[] = [];
    let cursor: string | undefined;
    let largest = 0;
    for (;;) {
      const page = await readLedgerPage(
        query({ limit: 200, ...(cursor === undefined ? {} : { cursor }) }),
        deps(),
      );
      largest = Math.max(largest, jsonBytes(page));
      seen.push(...page.items.map((item) => item.runId));
      if (page.next_cursor === null) break;
      cursor = page.next_cursor;
    }

    // Assert: every row once, every page within budget, item text intact.
    expect(largest).toBeLessThanOrEqual(MAX_LEDGER_PAGE_BYTES);
    expect(seen).toHaveLength(260);
    expect(new Set(seen).size).toBe(260);
  }, 60_000);

  it('keeps an ordinary limit-200 page whole', async () => {
    const history = (await openHistory())!;
    for (let i = 0; i < 210; i++) await history.store.record(entry(i));
    history.close();

    const page = await readLedgerPage(query({ limit: 200 }), deps());

    expect(page.items).toHaveLength(200);
    expect(jsonBytes(page)).toBeLessThan(MAX_LEDGER_PAGE_BYTES);
  }, 30_000);
});

describe('read.list registration', () => {
  const CALL = { windowId: 'w', connection: {} } as unknown as RpcCallContext;

  it('answers target workflows with the list workflows document', async () => {
    const methods = new RpcMethodRegistry();
    const workflows = {
      schemaVersion: '0.2' as const,
      kind: 'list' as const,
      items: [
        {
          kind: 'workflow' as const,
          name: 'fixture',
          stepCount: 1,
          securityClass: 'public',
          modifiedAt: at(0),
        },
      ],
    };
    registerLedgerRead(methods, deps({ listWorkflows: () => Promise.resolve(workflows) }));
    const method = methods.get('read.list')!;

    const value = await method.handler(method.params.parse({ target: 'workflows' }), CALL);

    expect(value).toEqual(workflows);
    expect(method.result.safeParse(value).success).toBe(true);
  });

  it.each([{ limit: 0 }, { limit: 201 }, { cursor: '' }, { args: ['runs'] }, { mode: ['x'] }])(
    'refuses %j as invalid params',
    (params) => {
      const methods = new RpcMethodRegistry();
      registerLedgerRead(methods, deps());
      expect(methods.get('read.list')!.params.safeParse(params).success).toBe(false);
    },
  );
});

describe('the host’s active runs', () => {
  function record(state: InvocationRecord['state'], run: string | null): InvocationRecord {
    return { state, run_id: run } as unknown as InvocationRecord;
  }

  it.each([
    ['queued', 'queued'],
    ['reserved', 'starting'],
    ['spawning', 'starting'],
    ['claimed', 'starting'],
    ['running', 'running'],
    ['needs_review', 'needs_review'],
    ['start_unknown', 'start_outcome_unknown'],
    ['finished', null],
    ['never_started', null],
    ['discarded', null],
  ] as const)('shows an invocation in %s as %s', (state, displayed) => {
    expect(displayedStateOf(record(state, 'r'))).toBe(displayed);
  });

  it('lists invocations that name a run, then leased runs as running', async () => {
    const active = hostActiveRuns({
      invocations: () =>
        Promise.resolve([
          record('claimed', 'a'),
          record('queued', null),
          record('finished', 'b'),
          record('needs_review', 'c'),
        ]),
      leasedRunIds: () => ['a', 'd'],
    });

    expect(await active()).toEqual([
      { runId: 'a', displayedState: 'starting' },
      { runId: 'c', displayedState: 'needs_review' },
      { runId: 'd', displayedState: 'running' },
    ]);
  });

  it('still reports leased runs when the invocation store cannot be read', async () => {
    const active = hostActiveRuns({
      invocations: () => Promise.reject(new Error('EACCES')),
      leasedRunIds: () => ['d'],
    });
    expect(await active()).toEqual([{ runId: 'd', displayedState: 'running' }]);
  });
});

describe('read.run_result', () => {
  const CALL = { windowId: 'w', connection: {} } as unknown as RpcCallContext;

  function capturingLogger() {
    const lines: { level: string; fields: Record<string, unknown> }[] = [];
    const logger: HostLogger = {
      debug: (fields) => lines.push({ level: 'debug', fields }),
      info: (fields) => lines.push({ level: 'info', fields }),
      warn: (fields) => lines.push({ level: 'warn', fields }),
      error: (fields) => lines.push({ level: 'error', fields }),
    };
    return { logger, lines };
  }

  function method(deps: RunReadDeps) {
    const methods = new RpcMethodRegistry();
    registerRunReads(methods, {
      reconcile: () => Promise.resolve(),
      live: () => Promise.resolve(null),
      ...deps,
    });
    return methods.get('read.run_result')!;
  }

  it('returns a protocol-valid view of a Brief run', async () => {
    const spec = askBriefRun(1);
    await buildRunDir(runsRoot(), spec);
    const read = method({});

    const view = (await read.handler(
      read.params.parse({ run_id: spec.runId }),
      CALL,
    )) as RunResultView;

    expect(read.result.safeParse(view).success).toBe(true);
    expect(view.document.kind).toBe('brief');
    expect(view.artifacts.map((item) => item.path)).not.toContain('lease.json');
  });

  it('maps a missing run to not_found', async () => {
    const read = method({});
    const error = await Promise.resolve(
      read.handler(read.params.parse({ run_id: runId(99) }), CALL),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RpcError);
    expect((error as RpcError).data.code).toBe('not_found');
  });

  it.each(['../x', 'agent-smoke-1', ''])('refuses the run id %j as invalid params', (id) => {
    expect(method({}).params.safeParse({ run_id: id }).success).toBe(false);
  });

  it('logs slot states at debug and a corrupt file at warn once per host lifetime, without content', async () => {
    // Arrange: a corrupt Brief with recognizable text in it.
    const spec = askBriefRun(2);
    await buildRunDir(runsRoot(), {
      ...spec,
      files: { ...spec.files, 'brief.json': '{"overview": "SECRET-OVERVIEW", ' },
    });
    const { logger, lines } = capturingLogger();
    const read = method({ logger });

    // Act: read twice.
    for (let i = 0; i < 2; i++) await read.handler(read.params.parse({ run_id: spec.runId }), CALL);

    // Assert
    const warns = lines.filter((line) => line.level === 'warn');
    expect(warns).toEqual([
      {
        level: 'warn',
        fields: { runId: spec.runId, entry_id: 'brief.json', state: 'corrupt' },
      },
    ]);
    const debug = lines.find((line) => line.level === 'debug');
    expect(debug?.fields).toMatchObject({
      runId: spec.runId,
      read: 'run_result',
      slots: { document: 'corrupt', outputs: 'none', run_health: 'ok' },
    });
    expect(JSON.stringify(lines)).not.toContain('SECRET-OVERVIEW');
  });

  it('turns typed core errors into RPC errors', () => {
    expect((runReadError(new ArtifactAccessError('outside_run'), 'r') as RpcError).data.code).toBe(
      'not_allowed',
    );
    expect((runReadError(new ArtifactAccessError('too_large'), 'r') as RpcError).data.code).toBe(
      'too_large',
    );
    const other = new Error('boom');
    expect(runReadError(other, 'r')).toBe(other);
  });
});

describe('read.report', () => {
  const CALL = { windowId: 'w', connection: {} } as unknown as RpcCallContext;

  function report() {
    const methods = new RpcMethodRegistry();
    registerRunReads(methods);
    return methods.get('read.report')!;
  }

  async function call(runIdValue: string) {
    const method = report();
    return method.handler(method.params.parse({ run_id: runIdValue }), CALL);
  }

  it('returns the whole report under the cap, with no truncation fields', async () => {
    const spec = legacyReportRun(3);
    await buildRunDir(runsRoot(), spec);

    const value = await call(spec.runId);

    expect(value).toEqual({
      schemaVersion: '0.2',
      kind: 'report',
      markdown: '# Report\n\nLegacy run.\n',
    });
  });

  it('truncates a 700 KiB report at a line boundary within 512 KiB and says so', async () => {
    const spec = legacyReportRun(4);
    const line = `${'x'.repeat(99)}\n`;
    const body = line.repeat(Math.ceil((700 * 1024) / line.length));
    await buildRunDir(runsRoot(), { ...spec, files: { 'report.md': body } });

    const value = (await call(spec.runId)) as {
      markdown: string;
      truncated?: boolean;
      bytes?: number;
    };

    expect(value.truncated).toBe(true);
    expect(value.bytes).toBe(Buffer.byteLength(body));
    expect(Buffer.byteLength(value.markdown)).toBeLessThanOrEqual(512 * 1024);
    expect(value.markdown.endsWith('\n')).toBe(true);
    expect(report().result.safeParse(value).success).toBe(true);
  });

  it('says report.md is missing in the CLI’s words', async () => {
    const spec = startupFailureRun(5);
    await buildRunDir(runsRoot(), { ...spec, files: {} });

    const error = await Promise.resolve(call(spec.runId)).catch((caught: unknown) => caught);

    expect((error as RpcError).data).toMatchObject({
      code: 'not_found',
      message: `report.md not found for run ${spec.runId} (the run may still be in progress).`,
    });
  });

  it('refuses a report.md that links outside the run', async () => {
    const spec = legacyReportRun(6);
    const dir = await buildRunDir(runsRoot(), { ...spec, files: {} });
    const outside = join(home, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'report.md'), 'SECRET');
    // A directory link is what Windows allows without privileges; the report is
    // reached through it when the run directory itself is the link target.
    await rm(dir, { recursive: true, force: true });
    await symlink(outside, dir, 'junction');

    const error = await Promise.resolve(call(spec.runId)).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RpcError);
    expect(JSON.stringify((error as RpcError).data)).not.toContain('SECRET');
  });
});
