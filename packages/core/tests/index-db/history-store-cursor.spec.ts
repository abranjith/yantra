// @no-llm
/**
 * Keyset pagination and the change token on the history index (FEAT-065
 * TASK-007/008).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteHistoryStore, type HistoryEntry } from '../../src/index-db/history-store.js';
import { runMigrations } from '../../src/index-db/migrations.js';
import { DatabaseSync } from '../../src/index-db/sqlite.js';

function entry(index: number, overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  const startedAt = new Date(Date.UTC(2026, 10, 1, 0, 0, index)).toISOString();
  return {
    runId: `run-${String(index).padStart(4, '0')}`,
    taskType: 'ask',
    intentText: `query ${index}`,
    briefId: null,
    status: 'succeeded',
    startedAt,
    finishedAt: startedAt,
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

async function page(
  limit: number,
  before?: { startedAt: string; runId: string },
): Promise<readonly HistoryEntry[]> {
  const result = await store.list({ limit, ...(before === undefined ? {} : { before }) });
  if (!result.isOk) throw result.error;
  return result.value;
}

describe('keyset cursor', () => {
  it('orders by started_at DESC, then run_id DESC', async () => {
    // Arrange: three rows share one start time.
    const same = '2026-11-01T00:00:00.000Z';
    for (const id of ['b', 'c', 'a']) await store.record(entry(0, { runId: id, startedAt: same }));

    // Act
    const rows = await page(10);

    // Assert
    expect(rows.map((row) => row.runId)).toEqual(['c', 'b', 'a']);
  });

  it('pages through 120 runs at 50 per page visiting each exactly once', async () => {
    for (let i = 0; i < 120; i++) await store.record(entry(i));
    const seen: string[] = [];
    let before: { startedAt: string; runId: string } | undefined;
    for (;;) {
      const rows = await page(50, before);
      seen.push(...rows.map((row) => row.runId));
      if (rows.length < 50) break;
      const last = rows.at(-1)!;
      before = { startedAt: last.startedAt, runId: last.runId };
    }
    expect(seen).toHaveLength(120);
    expect(new Set(seen).size).toBe(120);
  });

  it('is not shifted by a newer run inserted between pages', async () => {
    // Arrange
    for (let i = 0; i < 120; i++) await store.record(entry(i));
    const first = await page(50);
    const last = first.at(-1)!;

    // Act: a new, newest run arrives before page two is read.
    await store.record(entry(500));
    const second = await page(50, { startedAt: last.startedAt, runId: last.runId });

    // Assert: page two starts exactly after page one's last row.
    expect(second[0]?.runId).toBe('run-0069');
    expect(second.map((row) => row.runId)).not.toContain('run-0500');
  });

  it('splits ties on started_at by run_id across a page boundary', async () => {
    const same = '2026-11-01T00:00:00.000Z';
    for (const id of ['a', 'b', 'c', 'd'])
      await store.record(entry(0, { runId: id, startedAt: same }));
    const first = await page(2);
    const second = await page(2, { startedAt: same, runId: first.at(-1)!.runId });
    expect([...first, ...second].map((row) => row.runId)).toEqual(['d', 'c', 'b', 'a']);
  });

  it('returns nothing after the oldest row', async () => {
    await store.record(entry(1));
    const rows = await page(5, { startedAt: entry(1).startedAt, runId: entry(1).runId });
    expect(rows).toEqual([]);
  });
});

describe('changeToken', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'yantra-change-token-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('changes when another connection commits, and not for this connection’s own reads', async () => {
    // Arrange: two connections to one file, as the host and a CLI would have.
    const path = join(dir, 'index.db');
    const hostDb = new DatabaseSync(path);
    runMigrations(hostDb);
    const cliDb = new DatabaseSync(path);
    const host = new SqliteHistoryStore({ db: hostDb });
    const cli = new SqliteHistoryStore({ db: cliDb });
    const before = host.changeToken();

    // Act
    await host.list();
    const afterRead = host.changeToken();
    await cli.record(entry(1));
    const afterOtherCommit = host.changeToken();

    // Assert
    expect(before.isOk && afterRead.isOk && afterOtherCommit.isOk).toBe(true);
    if (before.isOk && afterRead.isOk && afterOtherCommit.isOk) {
      expect(afterRead.value).toBe(before.value);
      expect(afterOtherCommit.value).not.toBe(before.value);
    }
    hostDb.close();
    cliDb.close();
  });

  it('returns an error result on a closed connection instead of throwing', () => {
    const closed = new DatabaseSync(':memory:');
    const closedStore = new SqliteHistoryStore({ db: closed });
    closed.close();
    expect(closedStore.changeToken().isOk).toBe(false);
  });
});
