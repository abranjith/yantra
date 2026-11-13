// @no-llm
/**
 * `HistoryStore.page` and `knownRunIds` (FEAT-066 TASK-002): keyset paging
 * with ties, every Ledger filter alone and combined, literal text matching,
 * inert injection-shaped input, and the v5 index migration.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  SqliteHistoryStore,
  escapeLikePattern,
  type HistoryEntry,
  type HistoryPageQuery,
} from '../../src/index-db/history-store.js';
import { MIGRATIONS, currentSchemaVersion, runMigrations } from '../../src/index-db/migrations.js';
import { DatabaseSync } from '../../src/index-db/sqlite.js';

function iso(second: number): string {
  return new Date(Date.UTC(2026, 10, 1, 0, 0, second)).toISOString();
}

function entry(index: number, overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    runId: `run-${String(index).padStart(4, '0')}`,
    taskType: 'ask',
    intentText: `query ${index}`,
    briefId: null,
    status: 'succeeded',
    startedAt: iso(index),
    finishedAt: iso(index),
    durationMs: 1,
    costUsd: null,
    provider: null,
    taskOutcome: null,
    ...overrides,
  };
}

let db: DatabaseSync;
let store: SqliteHistoryStore;

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  runMigrations(db);
  store = new SqliteHistoryStore({ db });
});

afterEach(() => {
  db.close();
});

async function record(...entries: HistoryEntry[]): Promise<void> {
  for (const item of entries) {
    const result = await store.record(item);
    if (!result.isOk) throw result.error;
  }
}

async function ids(query: Partial<HistoryPageQuery> = {}): Promise<string[]> {
  const result = await store.page({ limit: 200, ...query });
  if (!result.isOk) throw result.error;
  return result.value.entries.map((item) => item.runId);
}

describe('keyset paging', () => {
  it('pages 120 rows with ties on started_at as 50/50/20, no gap or duplicate', async () => {
    // Arrange: 120 rows, every four sharing one start time.
    for (let i = 0; i < 120; i++) await record(entry(i, { startedAt: iso(Math.floor(i / 4)) }));

    // Act
    const pages: string[][] = [];
    let before: HistoryPageQuery['before'];
    for (;;) {
      const result = await store.page({ limit: 50, ...(before === undefined ? {} : { before }) });
      if (!result.isOk) throw result.error;
      pages.push(result.value.entries.map((item) => item.runId));
      const last = result.value.entries.at(-1);
      if (!result.value.hasMore || last === undefined) break;
      before = { startedAt: last.startedAt, runId: last.runId };
    }

    // Assert
    expect(pages.map((page) => page.length)).toEqual([50, 50, 20]);
    const all = pages.flat();
    expect(new Set(all).size).toBe(120);
    expect(all[0]).toBe('run-0119');
    expect(all.at(-1)).toBe('run-0000');
  });

  it('reports hasMore only when another row follows', async () => {
    await record(entry(1), entry(2));
    const exact = await store.page({ limit: 2 });
    const short = await store.page({ limit: 3 });
    expect(exact.isOk && exact.value.hasMore).toBe(false);
    expect(short.isOk && short.value.entries.length).toBe(2);
  });

  it('returns an empty page from an empty table', async () => {
    expect(await ids()).toEqual([]);
  });
});

describe('filters', () => {
  beforeEach(async () => {
    await record(
      entry(1, { taskOutcome: 'fulfilled', taskType: 'ask', intentText: 'weather in Pune' }),
      entry(2, { taskOutcome: 'failed', taskType: 'research', status: 'failed' }),
      entry(3, { taskOutcome: null, taskType: 'run', intentText: 'bank-statement' }),
      entry(4, { taskOutcome: 'partial', taskType: 'do', intentText: '100% off_sale \\ deals' }),
      entry(5, { taskOutcome: 'handoff', taskType: 'ask', status: 'handoff' }),
    );
  });

  it('filters by outcome', async () => {
    expect(await ids({ outcome: ['failed'] })).toEqual(['run-0002']);
    expect(await ids({ outcome: ['fulfilled', 'partial'] })).toEqual(['run-0004', 'run-0001']);
  });

  it('maps unknown to rows without an outcome (legacy rows)', async () => {
    expect(await ids({ outcome: ['unknown'] })).toEqual(['run-0003']);
    expect(await ids({ outcome: ['unknown', 'handoff'] })).toEqual(['run-0005', 'run-0003']);
  });

  it('filters by mode', async () => {
    expect(await ids({ mode: ['ask'] })).toEqual(['run-0005', 'run-0001']);
    expect(await ids({ mode: ['run', 'do'] })).toEqual(['run-0004', 'run-0003']);
  });

  it('filters by since (inclusive) and until (exclusive)', async () => {
    expect(await ids({ since: iso(4) })).toEqual(['run-0005', 'run-0004']);
    expect(await ids({ until: iso(2) })).toEqual(['run-0001']);
    expect(await ids({ since: iso(2), until: iso(4) })).toEqual(['run-0003', 'run-0002']);
  });

  it('matches text case-insensitively in the intent text or the run id', async () => {
    expect(await ids({ text: 'PUNE' })).toEqual(['run-0001']);
    expect(await ids({ text: 'run-0003' })).toEqual(['run-0003']);
  });

  it.each([
    ['%', ['run-0004']],
    ['_', ['run-0004']],
    ['\\', ['run-0004']],
    ['100%', ['run-0004']],
    ['off_sale', ['run-0004']],
  ])('matches %j literally', async (text, expected) => {
    expect(await ids({ text })).toEqual(expected);
  });

  it('keeps an injection-shaped string inert', async () => {
    expect(await ids({ text: "' OR 1=1 --" })).toEqual([]);
    expect(await ids({ text: "'); DROP TABLE history; --" })).toEqual([]);
    expect(await ids()).toHaveLength(5);
  });

  it('filters by workflow (intent text) and status, as list --workflow/--status do', async () => {
    expect(await ids({ workflow: 'bank-statement' })).toEqual(['run-0003']);
    expect(await ids({ status: 'handoff' })).toEqual(['run-0005']);
    expect(await ids({ workflow: 'bank' })).toEqual([]);
  });

  it('combines filters with AND', async () => {
    expect(await ids({ mode: ['ask'], outcome: ['handoff'], since: iso(1) })).toEqual(['run-0005']);
    expect(await ids({ mode: ['ask'], text: 'pune', outcome: ['failed'] })).toEqual([]);
  });

  it('applies filters together with the keyset', async () => {
    const first = await store.page({ limit: 1, mode: ['ask'] });
    if (!first.isOk) throw first.error;
    const last = first.value.entries[0]!;
    expect(first.value.hasMore).toBe(true);
    expect(
      await ids({ mode: ['ask'], before: { startedAt: last.startedAt, runId: last.runId } }),
    ).toEqual(['run-0001']);
  });
});

describe('escapeLikePattern', () => {
  it.each([
    ['plain', 'plain'],
    ['50%', '50\\%'],
    ['a_b', 'a\\_b'],
    ['c\\d', 'c\\\\d'],
  ])('%j → %j', (input, expected) => {
    expect(escapeLikePattern(input)).toBe(expected);
  });
});

describe('knownRunIds', () => {
  it('returns the ids with a row, ignoring the rest', async () => {
    await record(entry(1), entry(2));
    const result = await store.knownRunIds(['run-0001', 'run-0009', 'run-0002']);
    expect(result.isOk && [...result.value].sort()).toEqual(['run-0001', 'run-0002']);
  });

  it('handles an empty list and more ids than one batch', async () => {
    await record(entry(700));
    const many = Array.from({ length: 1_200 }, (_, i) => `run-${String(i).padStart(4, '0')}`);
    const empty = await store.knownRunIds([]);
    const big = await store.knownRunIds(many);
    expect(empty.isOk && empty.value.size).toBe(0);
    expect(big.isOk && [...big.value]).toEqual(['run-0700']);
  });
});

describe('migration v5', () => {
  function indexNames(handle: DatabaseSync): string[] {
    return (
      handle
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'history'")
        .all() as { name: string }[]
    ).map((row) => row.name);
  }

  it('applies on a v4 database and is idempotent when re-run', () => {
    // Arrange: a database migrated only to v4.
    const old = new DatabaseSync(':memory:');
    try {
      old.exec('BEGIN');
      for (const migration of MIGRATIONS.filter((item) => item.version <= 4)) migration.up(old);
      old.exec('PRAGMA user_version = 4');
      old.exec('COMMIT');
      expect(indexNames(old)).not.toContain('idx_history_started_run');

      // Act
      const version = runMigrations(old);
      const again = runMigrations(old);
      MIGRATIONS.find((item) => item.version === 5)!.up(old);

      // Assert
      expect(version).toBe(5);
      expect(again).toBe(5);
      expect(currentSchemaVersion(old)).toBe(5);
      expect(indexNames(old)).toContain('idx_history_started_run');
    } finally {
      old.close();
    }
  });

  it('serves the keyset query from the new index', () => {
    const plan = (
      db
        .prepare(
          'EXPLAIN QUERY PLAN SELECT run_id FROM history WHERE (started_at < ? OR (started_at = ? AND run_id < ?)) ORDER BY started_at DESC, run_id DESC LIMIT ?',
        )
        .all('x', 'x', 'y', 5) as { detail: string }[]
    )
      .map((row) => row.detail)
      .join('\n');
    expect(plan).toContain('idx_history_started_run');
  });
});
