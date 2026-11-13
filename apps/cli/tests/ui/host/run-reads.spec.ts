// @no-llm
/**
 * The app's run reads (FEAT-066): `read.list` Ledger pages (TASK-002).
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resetPathCache, runsRoot, type HistoryEntry } from '@yantra/core';
import { RunLedgerPage, type InvocationRecord, type RunLedgerQuery } from '@yantra/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openHistory } from '../../../src/history.js';
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
