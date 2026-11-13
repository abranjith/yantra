// @no-llm
/**
 * The Ledger query (FEAT-066 TASK-002): index and file sources merged as
 * `yantra list` merges them, keyset paging, filters, the file-scan cap and
 * early stop, active runs, enrichment and versioned cursors.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { err } from '@yantra/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SqliteHistoryStore, type HistoryEntry } from '../../src/index-db/history-store.js';
import { runMigrations } from '../../src/index-db/migrations.js';
import { DatabaseSync } from '../../src/index-db/sqlite.js';
import { IndexDbError } from '../../src/index-db/types.js';
import { LedgerCursorError } from '../../src/run-view/errors.js';
import {
  NODE_LEDGER_FS,
  compareNewestFirst,
  decodeLedgerCursor,
  encodeLedgerCursor,
  queryRunLedger,
  runIdStartMs,
  type LedgerFs,
  type LedgerQuery,
  type LedgerResult,
  type RunLedgerDeps,
} from '../../src/run-view/ledger.js';

import {
  agenticManifest,
  buildRunDir,
  fixtureInstant,
  fixtureRunId,
  workflowManifest,
} from './fixtures/build-run-dir.js';

let runsDir: string;
let db: DatabaseSync;
let store: SqliteHistoryStore;

beforeEach(async () => {
  runsDir = await mkdtemp(join(tmpdir(), 'yantra-ledger-'));
  db = new DatabaseSync(':memory:');
  runMigrations(db);
  store = new SqliteHistoryStore({ db, runsDir });
});

afterEach(async () => {
  db.close();
  await rm(runsDir, { recursive: true, force: true });
});

function historyEntry(seconds: number, overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    runId: fixtureRunId(seconds),
    taskType: 'run',
    intentText: 'fixture',
    briefId: null,
    status: 'succeeded',
    startedAt: fixtureInstant(seconds),
    finishedAt: fixtureInstant(seconds),
    durationMs: 1000,
    costUsd: null,
    provider: null,
    taskOutcome: null,
    ...overrides,
  };
}

async function fileRun(seconds: number, overrides: Record<string, unknown> = {}): Promise<string> {
  const runId = fixtureRunId(seconds);
  await buildRunDir(runsDir, {
    runId,
    manifest: workflowManifest(runId, { startedAt: fixtureInstant(seconds), ...overrides }),
  });
  return runId;
}

function query(overrides: Partial<LedgerQuery> = {}): LedgerQuery {
  return { limit: 50, activeMode: 'inline', ...overrides };
}

function deps(overrides: Partial<RunLedgerDeps> = {}): RunLedgerDeps {
  return { historyStore: store, runsDir, ...overrides };
}

async function walk(q: LedgerQuery, d: RunLedgerDeps): Promise<{ ids: string[]; pages: number }> {
  const ids: string[] = [];
  let pages = 0;
  let before: LedgerQuery['before'];
  for (;;) {
    const page: LedgerResult = await queryRunLedger(
      { ...q, ...(before === undefined ? {} : { before }) },
      d,
    );
    pages += 1;
    ids.push(...page.items.map((item) => item.runId));
    if (page.next === null) break;
    before = page.next;
  }
  return { ids, pages };
}

describe('sources', () => {
  it('pages index rows by keyset with no gap or duplicate', async () => {
    for (let i = 0; i < 120; i++)
      await store.record(
        historyEntry(Math.floor(i / 3), { runId: `r-${String(i).padStart(3, '0')}` }),
      );

    const { ids, pages } = await walk(query({ limit: 50 }), deps());

    expect(pages).toBe(3);
    expect(ids).toHaveLength(120);
    expect(new Set(ids).size).toBe(120);
  });

  it('produces the same order from files as from the index', async () => {
    // Arrange: the same 30 runs on disk and in the index, with tied start times.
    for (let i = 0; i < 30; i++) {
      const seconds = Math.floor(i / 2);
      const runId = fixtureRunId(seconds, 'fixture', `a${String(i).padStart(7, '0')}`);
      await buildRunDir(runsDir, {
        runId,
        manifest: workflowManifest(runId, { startedAt: fixtureInstant(seconds) }),
      });
      await store.record(historyEntry(seconds, { runId }));
    }

    const fromIndex = await walk(query({ limit: 7 }), deps());
    const fromFiles = await walk(query({ limit: 7 }), deps({ historyStore: null }));

    expect(fromFiles.ids).toEqual(fromIndex.ids);
    expect(fromIndex.ids).toHaveLength(30);
  });

  it('reports the source', async () => {
    await fileRun(1);
    expect((await queryRunLedger(query(), deps())).source).toBe('index');
    expect((await queryRunLedger(query(), deps({ historyStore: null }))).source).toBe('files');
  });

  it('falls back to files when the index fails', async () => {
    await fileRun(1);
    const failing: SqliteHistoryStore = Object.assign(Object.create(store) as SqliteHistoryStore, {
      page: () =>
        Promise.resolve(err(new IndexDbError('locked', { op: 'history.page' }))) as ReturnType<
          SqliteHistoryStore['page']
        >,
    });

    const page = await queryRunLedger(query(), deps({ historyStore: failing }));

    expect(page.source).toBe('files');
    expect(page.items.map((item) => item.runId)).toEqual([fixtureRunId(1)]);
  });

  it('merges file-only runs with index rows; the index row wins a shared run id', async () => {
    const shared = await fileRun(2, { status: 'completed' });
    await store.record(historyEntry(2, { runId: shared, status: 'succeeded' }));
    await fileRun(3, { status: 'running' });
    await store.record(historyEntry(1));

    const page = await queryRunLedger(query(), deps());

    expect(page.items.map((item) => [item.runId, item.status])).toEqual([
      [fixtureRunId(3), 'running'],
      [shared, 'succeeded'],
      [fixtureRunId(1), 'succeeded'],
    ]);
  });

  it('drops a file row the index knows even when a filter excludes the index row', async () => {
    // `list --status completed` never showed a run whose index row says succeeded.
    const shared = await fileRun(2, { status: 'completed' });
    await store.record(historyEntry(2, { runId: shared, status: 'succeeded' }));

    const page = await queryRunLedger(query({ status: 'completed' }), deps());

    expect(page.items).toEqual([]);
  });

  it('skips a corrupt manifest and keeps the other rows', async () => {
    await fileRun(1);
    await fileRun(3);
    await buildRunDir(runsDir, { runId: fixtureRunId(2), manifest: '{ not json' });
    await buildRunDir(runsDir, { runId: 'not-a-run-id', manifest: '[1,2]' });

    const page = await queryRunLedger(query(), deps({ historyStore: null }));

    expect(page.items.map((item) => item.runId)).toEqual([fixtureRunId(3), fixtureRunId(1)]);
  });

  it('returns nothing when the runs directory does not exist', async () => {
    const page = await queryRunLedger(query(), deps({ runsDir: join(runsDir, 'missing') }));
    expect(page.items).toEqual([]);
    expect(page.next).toBeNull();
  });

  it('lists directories that do not use the run-id grammar (they are always read)', async () => {
    await buildRunDir(runsDir, {
      runId: 'legacy-run',
      manifest: workflowManifest('legacy-run', { startedAt: fixtureInstant(9) }),
    });
    await fileRun(1);

    const page = await queryRunLedger(query(), deps({ historyStore: null }));

    expect(page.items.map((item) => item.runId)).toEqual(['legacy-run', fixtureRunId(1)]);
  });
});

describe('the file scan', () => {
  function countingFs(): LedgerFs & { reads: () => number } {
    let reads = 0;
    return {
      readdir: NODE_LEDGER_FS.readdir,
      readFile: (path) => {
        if (path.endsWith('manifest.json')) reads += 1;
        return NODE_LEDGER_FS.readFile(path);
      },
      exists: NODE_LEDGER_FS.exists,
      reads: () => reads,
    };
  }

  it('sets scanTruncated at the cap on the file fallback', async () => {
    for (let i = 0; i < 30; i++) await fileRun(i);

    const page = await queryRunLedger(
      query({ limit: 50 }),
      deps({ historyStore: null, fileScanCap: 10 }),
    );

    expect(page.scanTruncated).toBe(true);
    expect(page.items.length).toBeLessThanOrEqual(10);
    expect(page.items[0]?.runId).toBe(fixtureRunId(29));
  });

  it('never reports scanTruncated when the index answered', async () => {
    for (let i = 0; i < 30; i++) await fileRun(i);
    const page = await queryRunLedger(query(), deps({ fileScanCap: 10 }));
    expect(page.scanTruncated).toBe(false);
  });

  it('stops reading once no older directory can enter the page', async () => {
    // Arrange: 300 runs an hour apart, each well beyond the start slack.
    for (let i = 0; i < 300; i++) await fileRun(i * 3600);
    const fs = countingFs();

    // Act
    const page = await queryRunLedger(query({ limit: 10 }), deps({ historyStore: null, fs }));

    // Assert: one or two chunks, never all 300 manifests.
    expect(page.items).toHaveLength(10);
    expect(fs.reads()).toBeLessThanOrEqual(100);
  });

  it('only reads directories newer than the index page needs when the index answers', async () => {
    for (let i = 0; i < 300; i++) {
      const runId = await fileRun(i * 3600);
      await store.record(historyEntry(i * 3600, { runId }));
    }
    const fs = countingFs();

    const page = await queryRunLedger(query({ limit: 10 }), deps({ fs }));

    expect(page.items).toHaveLength(10);
    expect(fs.reads()).toBeLessThanOrEqual(100);
  });

  it('skips directories that began after the cursor without reading them', async () => {
    for (let i = 0; i < 200; i++) await fileRun(i * 3600);
    const fs = countingFs();

    const page = await queryRunLedger(
      query({
        limit: 5,
        before: { startedAt: fixtureInstant(50 * 3600), runId: fixtureRunId(50 * 3600) },
      }),
      deps({ historyStore: null, fs }),
    );

    expect(page.items[0]?.runId).toBe(fixtureRunId(49 * 3600));
    expect(fs.reads()).toBeLessThanOrEqual(50);
  });

  it('still finds a run whose manifest started within the slack after its name', async () => {
    // The directory name says second 100; the manifest says 4 minutes later.
    const late = fixtureRunId(100, 'late');
    await buildRunDir(runsDir, {
      runId: late,
      manifest: workflowManifest(late, { startedAt: fixtureInstant(100 + 240) }),
    });
    await fileRun(200);
    await fileRun(150);

    const page = await queryRunLedger(query({ limit: 2 }), deps({ historyStore: null }));

    expect(page.items.map((item) => item.runId)).toEqual([late, fixtureRunId(200)]);
  });
});

describe('filters on file rows', () => {
  beforeEach(async () => {
    const ask = fixtureRunId(1, 'ask');
    await buildRunDir(runsDir, {
      runId: ask,
      manifest: agenticManifest(ask, 'ask', {
        startedAt: fixtureInstant(1),
        taskOutcome: 'fulfilled',
      }),
    });
    await fileRun(2, { taskOutcome: 'failed', status: 'failed', workflowName: 'Bank-Statement' });
    await fileRun(3);
  });

  async function ids(q: Partial<LedgerQuery>): Promise<string[]> {
    return (await queryRunLedger(query(q), deps({ historyStore: null }))).items.map(
      (item) => item.runId,
    );
  }

  it('filters by outcome, with unknown for runs without one', async () => {
    expect(await ids({ outcome: ['failed'] })).toEqual([fixtureRunId(2)]);
    expect(await ids({ outcome: ['unknown'] })).toEqual([fixtureRunId(3)]);
  });

  it('filters by mode (agentic manifests carry their command)', async () => {
    expect(await ids({ mode: ['ask'] })).toEqual([fixtureRunId(1, 'ask')]);
    expect(await ids({ mode: ['run'] })).toEqual([fixtureRunId(3), fixtureRunId(2)]);
  });

  it('filters by text, case-insensitively, in the name or the run id', async () => {
    expect(await ids({ text: 'bank' })).toEqual([fixtureRunId(2)]);
    expect(await ids({ text: '%' })).toEqual([]);
  });

  it('filters by since and until', async () => {
    expect(await ids({ since: fixtureInstant(2), until: fixtureInstant(3) })).toEqual([
      fixtureRunId(2),
    ]);
  });

  it('filters by workflow and status exactly', async () => {
    expect(await ids({ workflow: 'Bank-Statement' })).toEqual([fixtureRunId(2)]);
    expect(await ids({ workflow: 'bank-statement' })).toEqual([]);
    expect(await ids({ status: 'failed' })).toEqual([fixtureRunId(2)]);
  });
});

describe('active runs', () => {
  it('keeps unfinished runs in items for the CLI (inline)', async () => {
    await fileRun(2, { status: 'running' });
    const page = await queryRunLedger(query(), deps());
    expect(page.items.map((item) => item.status)).toEqual(['running']);
    expect(page.active).toEqual([]);
  });

  it('returns unfinished runs separately, on the first page only (split)', async () => {
    // Arrange
    const running = await fileRun(5, { status: 'running' });
    const queued = await fileRun(4, { status: 'queued' });
    for (let i = 0; i < 3; i++) await fileRun(i);

    // Act
    const first = await queryRunLedger(query({ limit: 2, activeMode: 'split' }), deps());
    const second = await queryRunLedger(
      query({ limit: 2, activeMode: 'split', before: first.next! }),
      deps(),
    );

    // Assert
    expect(first.items.map((item) => item.runId)).toEqual([fixtureRunId(2), fixtureRunId(1)]);
    expect(first.active.map((run) => [run.runId, run.displayedState])).toEqual([
      [running, 'unknown_owner'],
      [queued, 'queued'],
    ]);
    expect(second.active).toEqual([]);
    expect(second.items.map((item) => item.runId)).toEqual([fixtureRunId(0)]);
  });

  it('takes the displayed state the host reports, and skips runs that already ended', async () => {
    const live = await fileRun(5, { status: 'running' });
    const ended = await fileRun(4, { status: 'completed' });

    const page = await queryRunLedger(
      query({ activeMode: 'split' }),
      deps({
        activeRuns: () =>
          Promise.resolve([
            { runId: live, displayedState: 'waiting_for_you' },
            { runId: ended, displayedState: 'running' },
            {
              runId: fixtureRunId(9),
              displayedState: 'starting',
              workflowName: 'research',
              startedAt: fixtureInstant(9),
            },
            { runId: fixtureRunId(8), displayedState: 'running' },
          ]),
      }),
    );

    expect(page.active.map((run) => [run.runId, run.displayedState, run.status])).toEqual([
      [fixtureRunId(9), 'starting', 'running'],
      [live, 'waiting_for_you', 'running'],
    ]);
  });

  it('ignores a host-reported run id that is not a well-formed run id', async () => {
    const page = await queryRunLedger(
      query({ activeMode: 'split' }),
      deps({
        activeRuns: () =>
          Promise.resolve([
            {
              runId: '../outside',
              displayedState: 'running',
              workflowName: 'x',
              startedAt: fixtureInstant(1),
            },
          ]),
      }),
    );
    expect(page.active).toEqual([]);
  });

  it('applies the filters to active runs too', async () => {
    await fileRun(5, { status: 'running' });
    const page = await queryRunLedger(query({ activeMode: 'split', outcome: ['failed'] }), deps());
    expect(page.active).toEqual([]);
  });
});

describe('enrichment', () => {
  it('adds the execution state, document flag, task type and cost after the existing fields', async () => {
    // Arrange
    const runId = fixtureRunId(1);
    await buildRunDir(runsDir, {
      runId,
      manifest: workflowManifest(runId, {
        startedAt: fixtureInstant(1),
        executionState: 'interrupted',
        taskOutcome: 'failed',
      }),
      files: { 'brief.json': {} },
    });
    await store.record(historyEntry(1, { runId, costUsd: 0.25, taskOutcome: 'failed' }));

    // Act
    const [item] = (await queryRunLedger(query(), deps())).items;

    // Assert
    expect(Object.keys(item!)).toEqual([
      'kind',
      'runId',
      'workflowName',
      'status',
      'startedAt',
      'durationMs',
      'taskOutcome',
      'executionState',
      'taskType',
      'costUsd',
      'hasDocument',
    ]);
    expect(item).toMatchObject({ executionState: 'interrupted', costUsd: 0.25, hasDocument: true });
  });

  it('reports hasDocument from a templated document and false when there is none', async () => {
    await buildRunDir(runsDir, {
      runId: fixtureRunId(2),
      manifest: workflowManifest(fixtureRunId(2), { startedAt: fixtureInstant(2) }),
      files: { 'document.json': {} },
    });
    await fileRun(1);

    const items = (await queryRunLedger(query(), deps({ historyStore: null }))).items;

    expect(items.map((item) => item.hasDocument)).toEqual([true, false]);
    expect(items.map((item) => item.costUsd)).toEqual([null, null]);
  });

  it('drops an outcome word the protocol does not know', async () => {
    await fileRun(1, { taskOutcome: 'maybe' });
    const [item] = (await queryRunLedger(query(), deps())).items;
    expect(item?.taskOutcome).toBeUndefined();
  });
});

describe('reconciliation', () => {
  it('runs first, and its failure never fails the page', async () => {
    await fileRun(1);
    const reconcile = vi.fn(() => Promise.reject(new Error('locked')));

    const page = await queryRunLedger(query(), deps({ reconcile }));

    expect(reconcile).toHaveBeenCalledOnce();
    expect(page.items).toHaveLength(1);
  });
});

describe('cursors', () => {
  it('round-trips a position and its source', () => {
    const key = { startedAt: fixtureInstant(5), runId: fixtureRunId(5) };
    expect(decodeLedgerCursor(encodeLedgerCursor(key, 'files'))).toEqual({
      ...key,
      source: 'files',
    });
  });

  it.each([
    ['not base64url', 'not a cursor!!', 'encoding'],
    ['base64url of non-JSON', Buffer.from('nope').toString('base64url'), 'encoding'],
    [
      'a foreign version',
      Buffer.from(
        JSON.stringify({ v: 2, started_at: fixtureInstant(1), run_id: 'r', source: 'index' }),
      ).toString('base64url'),
      'schema',
    ],
    [
      'a tampered timestamp',
      Buffer.from(
        JSON.stringify({ v: 1, started_at: 'yesterday', run_id: 'r', source: 'index' }),
      ).toString('base64url'),
      'schema',
    ],
    [
      'an extra field',
      Buffer.from(
        JSON.stringify({
          v: 1,
          started_at: fixtureInstant(1),
          run_id: 'r',
          source: 'index',
          x: 1,
        }),
      ).toString('base64url'),
      'schema',
    ],
    [
      'the FEAT-065 cursor shape',
      Buffer.from('{"v":1,"s":"x","r":"y"}').toString('base64url'),
      'schema',
    ],
  ])('refuses %s with LedgerCursorError', (_label, cursor, reason) => {
    let caught: unknown;
    try {
      decodeLedgerCursor(cursor);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(LedgerCursorError);
    expect((caught as LedgerCursorError).reason).toBe(reason);
  });
});

describe('helpers', () => {
  it('reads the start second from a run id, and null from other names', () => {
    expect(runIdStartMs('20261101T000005Z-x-1')).toBe(Date.parse(fixtureInstant(5)));
    expect(runIdStartMs('legacy-run')).toBeNull();
  });

  it('orders newest first, then by run id descending, by binary comparison', () => {
    const keys = [
      { startedAt: 'b', runId: 'x' },
      { startedAt: 'b', runId: 'y' },
      { startedAt: 'a', runId: 'z' },
    ];
    expect([...keys].sort(compareNewestFirst).map((key) => key.runId)).toEqual(['y', 'x', 'z']);
  });
});
