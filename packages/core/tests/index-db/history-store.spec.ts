import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  SqliteHistoryStore,
  deriveHistoryEntry,
  type HistoryEntry,
} from '../../src/index-db/history-store.js';
import { runMigrations } from '../../src/index-db/migrations.js';
import { DatabaseSync } from '../../src/index-db/sqlite.js';

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  runMigrations(db);
  return db;
}

function entry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    runId: 'run-1',
    taskType: 'ask',
    intentText: 'cheapest headphones',
    briefId: null,
    status: 'succeeded',
    startedAt: '2026-07-01T10:00:00.000Z',
    finishedAt: '2026-07-01T10:00:03.000Z',
    durationMs: 3000,
    costUsd: 0.02,
    provider: 'tavily',
    ...overrides,
  };
}

describe('@no-llm SqliteHistoryStore', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = makeDb();
  });

  afterEach(() => {
    db.close();
  });

  it('records a task and reads it back via list (round-trip)', async () => {
    const store = new SqliteHistoryStore({ db });

    const recorded = await store.record(entry());
    expect(recorded.isOk).toBe(true);

    const listed = await store.list();
    expect(listed.isOk).toBe(true);
    if (!listed.isOk) return;
    expect(listed.value).toHaveLength(1);
    expect(listed.value[0]).toMatchObject({
      runId: 'run-1',
      taskType: 'ask',
      intentText: 'cheapest headphones',
      status: 'succeeded',
      costUsd: 0.02,
      provider: 'tavily',
    });
  });

  it('upserts on duplicate run_id (resume overwrites, no duplicate row)', async () => {
    const store = new SqliteHistoryStore({ db });

    await store.record(entry({ status: 'failed', finishedAt: null, durationMs: null }));
    await store.record(entry({ status: 'succeeded', finishedAt: '2026-07-01T10:00:05.000Z' }));

    const listed = await store.list();
    if (!listed.isOk) throw new Error('list failed');
    expect(listed.value).toHaveLength(1);
    expect(listed.value[0]?.status).toBe('succeeded');
    expect(listed.value[0]?.finishedAt).toBe('2026-07-01T10:00:05.000Z');
  });

  it('lists most-recent first and honors the limit', async () => {
    const store = new SqliteHistoryStore({ db });
    await store.record(entry({ runId: 'a', startedAt: '2026-07-01T09:00:00.000Z' }));
    await store.record(entry({ runId: 'b', startedAt: '2026-07-01T11:00:00.000Z' }));
    await store.record(entry({ runId: 'c', startedAt: '2026-07-01T10:00:00.000Z' }));

    const listed = await store.list({ limit: 2 });
    if (!listed.isOk) throw new Error('list failed');
    expect(listed.value.map((e) => e.runId)).toEqual(['b', 'c']);
  });

  it('filters by task type and since', async () => {
    const store = new SqliteHistoryStore({ db });
    await store.record(
      entry({ runId: 'ask-old', taskType: 'ask', startedAt: '2026-06-01T00:00:00.000Z' }),
    );
    await store.record(
      entry({ runId: 'ask-new', taskType: 'ask', startedAt: '2026-07-02T00:00:00.000Z' }),
    );
    await store.record(
      entry({ runId: 'run-x', taskType: 'run', startedAt: '2026-07-02T00:00:00.000Z' }),
    );

    const asks = await store.list({ taskType: 'ask' });
    if (!asks.isOk) throw new Error('list failed');
    expect(asks.value.map((e) => e.runId).sort()).toEqual(['ask-new', 'ask-old']);

    const recent = await store.list({ since: '2026-07-01T00:00:00.000Z' });
    if (!recent.isOk) throw new Error('list failed');
    expect(recent.value.map((e) => e.runId).sort()).toEqual(['ask-new', 'run-x']);
  });

  it('rolls up cost by provider and day', async () => {
    const store = new SqliteHistoryStore({ db });
    await store.record(
      entry({
        runId: '1',
        startedAt: '2026-07-01T08:00:00.000Z',
        provider: 'tavily',
        costUsd: 0.01,
      }),
    );
    await store.record(
      entry({
        runId: '2',
        startedAt: '2026-07-01T20:00:00.000Z',
        provider: 'tavily',
        costUsd: 0.03,
      }),
    );
    await store.record(
      entry({
        runId: '3',
        startedAt: '2026-07-02T08:00:00.000Z',
        provider: 'brave',
        costUsd: 0.05,
      }),
    );
    await store.record(
      entry({ runId: '4', startedAt: '2026-07-02T09:00:00.000Z', provider: null, costUsd: null }),
    );

    const rollup = await store.usageRollup();
    if (!rollup.isOk) throw new Error('rollup failed');

    const tavilyDay1 = rollup.value.find((r) => r.day === '2026-07-01' && r.provider === 'tavily');
    expect(tavilyDay1).toMatchObject({ taskCount: 2, totalCostUsd: 0.04 });

    const braveDay2 = rollup.value.find((r) => r.day === '2026-07-02' && r.provider === 'brave');
    expect(braveDay2).toMatchObject({ taskCount: 1, totalCostUsd: 0.05 });

    const nullProvider = rollup.value.find((r) => r.day === '2026-07-02' && r.provider === null);
    expect(nullProvider).toMatchObject({ taskCount: 1, totalCostUsd: 0 });
  });

  it('returns an empty list when the store is empty', async () => {
    const store = new SqliteHistoryStore({ db });
    const listed = await store.list();
    if (!listed.isOk) throw new Error('list failed');
    expect(listed.value).toEqual([]);
  });
});

describe('@no-llm SqliteHistoryStore.rebuildFromRuns', () => {
  let runsDir: string;
  let db: DatabaseSync;

  beforeEach(async () => {
    runsDir = await mkdtemp(join(tmpdir(), 'yantra-runs-'));
    db = makeDb();
  });

  afterEach(async () => {
    db.close();
    await rm(runsDir, { recursive: true, force: true });
  });

  async function writeRun(name: string, manifest: unknown, brief?: unknown): Promise<void> {
    const runDir = join(runsDir, name);
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, 'manifest.json'), JSON.stringify(manifest), 'utf8');
    if (brief !== undefined) {
      await writeFile(join(runDir, 'brief.json'), JSON.stringify(brief), 'utf8');
    }
  }

  it('reconstructs history from ask + workflow manifests, skipping junk dirs', async () => {
    await writeRun(
      'ask-run',
      {
        task_id: 't1',
        type: 'ask',
        query: 'best laptop',
        search_provider: 'brave',
        started_at: '2026-07-01T10:00:00.000Z',
        finished_at: '2026-07-01T10:00:04.000Z',
        status: 'ok',
      },
      { brief_id: 'brief-1', metadata: { usage: { cost_usd: 0.09 } } },
    );
    await writeRun('workflow-run', {
      runId: '20260701T120000Z-bank-abcd',
      workflowName: 'bank-statement',
      status: 'completed',
      startedAt: '2026-07-01T12:00:00.000Z',
      endedAt: '2026-07-01T12:00:30.000Z',
      durationMs: 30000,
    });
    // A dir with no manifest — must be skipped.
    await mkdir(join(runsDir, 'incomplete'), { recursive: true });

    const store = new SqliteHistoryStore({ db, runsDir });
    const result = await store.rebuildFromRuns();
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.rowCount).toBe(2);

    const listed = await store.list();
    if (!listed.isOk) return;
    const ask = listed.value.find((e) => e.runId === 'ask-run');
    expect(ask).toMatchObject({
      taskType: 'ask',
      intentText: 'best laptop',
      briefId: 'brief-1',
      costUsd: 0.09,
      provider: 'brave',
      durationMs: 4000,
    });
    const run = listed.value.find((e) => e.taskType === 'run');
    expect(run).toMatchObject({
      runId: '20260701T120000Z-bank-abcd',
      intentText: 'bank-statement',
      status: 'succeeded',
      durationMs: 30000,
    });
  });

  it('is idempotent — a second rebuild does not duplicate rows', async () => {
    await writeRun('ask-run', {
      type: 'ask',
      query: 'q',
      started_at: '2026-07-01T10:00:00.000Z',
      finished_at: '2026-07-01T10:00:01.000Z',
      status: 'ok',
    });
    const store = new SqliteHistoryStore({ db, runsDir });
    await store.rebuildFromRuns();
    const second = await store.rebuildFromRuns();
    expect(second.isOk).toBe(true);
    const listed = await store.list();
    if (!listed.isOk) return;
    expect(listed.value).toHaveLength(1);
  });

  it('records a single completed run from its run dir (record-on-completion path)', async () => {
    await writeRun(
      'ask-1',
      {
        type: 'ask',
        query: 'hello world',
        search_provider: 'tavily',
        started_at: '2026-07-01T10:00:00.000Z',
        finished_at: '2026-07-01T10:00:02.000Z',
        status: 'ok',
      },
      { brief_id: 'b-1', metadata: { usage: { cost_usd: 0.04 } } },
    );

    const store = new SqliteHistoryStore({ db, runsDir });
    const recorded = await store.recordFromRunDir('ask-1');
    expect(recorded.isOk).toBe(true);
    if (recorded.isOk) expect(recorded.value).toBe(true);

    const listed = await store.list();
    if (!listed.isOk) return;
    expect(listed.value).toHaveLength(1);
    expect(listed.value[0]).toMatchObject({ runId: 'ask-1', briefId: 'b-1', costUsd: 0.04 });
  });

  it('recordFromRunDir returns ok(false) for a missing manifest', async () => {
    const store = new SqliteHistoryStore({ db, runsDir });
    const recorded = await store.recordFromRunDir('nope');
    expect(recorded.isOk).toBe(true);
    if (recorded.isOk) expect(recorded.value).toBe(false);
  });

  it('returns zero rows when the runs directory is absent', async () => {
    const store = new SqliteHistoryStore({ db, runsDir: join(runsDir, 'does-not-exist') });
    const result = await store.rebuildFromRuns();
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.rowCount).toBe(0);
  });
});

describe('@no-llm deriveHistoryEntry', () => {
  it('maps a failed ask manifest status to failed', () => {
    const e = deriveHistoryEntry(
      'r',
      { type: 'ask', query: 'q', started_at: '2026-07-01T00:00:00.000Z', status: 'failed' },
      null,
    );
    expect(e?.status).toBe('failed');
  });

  it('maps a partial ask manifest status to succeeded', () => {
    const e = deriveHistoryEntry(
      'r',
      { type: 'ask', query: 'q', started_at: '2026-07-01T00:00:00.000Z', status: 'partial' },
      null,
    );
    expect(e?.status).toBe('succeeded');
  });

  it('maps workflow statuses (paused → handoff, aborted → aborted)', () => {
    const paused = deriveHistoryEntry(
      'r',
      { workflowName: 'w', status: 'paused', startedAt: '2026-07-01T00:00:00.000Z' },
      null,
    );
    expect(paused?.status).toBe('handoff');
    const aborted = deriveHistoryEntry(
      'r',
      { workflowName: 'w', status: 'aborted', startedAt: '2026-07-01T00:00:00.000Z' },
      null,
    );
    expect(aborted?.status).toBe('aborted');
  });

  it('returns null for a non-terminal (running) workflow manifest', () => {
    const e = deriveHistoryEntry(
      'r',
      { workflowName: 'w', status: 'running', startedAt: '2026-07-01T00:00:00.000Z' },
      null,
    );
    expect(e).toBeNull();
  });

  it('returns null for an unrecognized manifest shape', () => {
    expect(deriveHistoryEntry('r', { foo: 'bar' }, null)).toBeNull();
  });
});
