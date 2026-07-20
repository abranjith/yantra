import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RANK_MAX, RANK_MIN, SqliteDomainRankStore } from '../../src/index-db/domain-rank-store.js';
import {
  currentSchemaVersion,
  MIGRATIONS,
  runMigrations,
  SCHEMA_VERSION,
} from '../../src/index-db/migrations.js';
import { DatabaseSync } from '../../src/index-db/sqlite.js';

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  runMigrations(db);
  return db;
}

describe('@no-llm migration v3', () => {
  it('applies on a fresh database with its table, index, and constraints', () => {
    const db = makeDb();
    expect(currentSchemaVersion(db)).toBe(SCHEMA_VERSION);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='domain_ranks'").get(),
    ).toBeDefined();
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_domain_ranks_rank'",
        )
        .get(),
    ).toBeDefined();

    const insert = db.prepare(
      `INSERT INTO domain_ranks
         (domain, rank, positive_signals, negative_signals, origin, first_seen_at, last_signal_at)
       VALUES (?, ?, 0, 0, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    );
    expect(() => insert.run('too-high.example', 101, 'auto')).toThrow();
    expect(() => insert.run('too-low.example', -101, 'auto')).toThrow();
    expect(() => insert.run('bad-origin.example', 0, 'manual')).toThrow();
    db.close();
  });

  it('upgrades a v2 database and is idempotent when rerun', () => {
    const db = new DatabaseSync(':memory:');
    for (const migration of MIGRATIONS.filter((item) => item.version <= 2)) {
      migration.up(db);
      db.exec(`PRAGMA user_version = ${migration.version}`);
    }
    db.prepare(
      "INSERT INTO preferences (key, value, source, approved, updated_at) VALUES ('k', '1', 'user', 1, 'now')",
    ).run();

    expect(runMigrations(db)).toBe(3);
    expect(runMigrations(db)).toBe(3);
    expect(db.prepare('SELECT value FROM preferences WHERE key = ?').get('k')).toMatchObject({
      value: '1',
    });
    db.close();
  });
});

describe('@no-llm SqliteDomainRankStore', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = makeDb();
  });

  afterEach(() => {
    db.close();
  });

  it('applies positive and negative signals with counters and timestamps', () => {
    const times = [new Date('2026-01-01T00:00:00.000Z'), new Date('2026-01-02T00:00:00.000Z')];
    const store = new SqliteDomainRankStore({
      db,
      clock: () => times.shift() ?? new Date(0),
    });

    expect(
      store.applySignal({ domain: 'WWW.Example.COM', delta: 1, reason: 'search_result' }).isOk,
    ).toBe(true);
    expect(
      store.applySignal({ domain: 'example.com', delta: -1, reason: 'fetch_failed' }).isOk,
    ).toBe(true);

    const list = store.list();
    if (!list.isOk) throw list.error;
    expect(list.value).toEqual([
      {
        domain: 'example.com',
        rank: 0,
        positiveSignals: 1,
        negativeSignals: 1,
        origin: 'auto',
        firstSeenAt: '2026-01-01T00:00:00.000Z',
        lastSignalAt: '2026-01-02T00:00:00.000Z',
      },
    ]);
  });

  it('clamps rank at both bounds while continuing to count observations', () => {
    const store = new SqliteDomainRankStore({ db });
    for (let i = 0; i < 125; i += 1) {
      store.applySignal({ domain: 'high.example', delta: 1, reason: 'search_result' });
      store.applySignal({ domain: 'low.example', delta: -1, reason: 'extract_failed' });
    }

    const list = store.list();
    if (!list.isOk) throw list.error;
    expect(list.value.find((row) => row.domain === 'high.example')).toMatchObject({
      rank: RANK_MAX,
      positiveSignals: 125,
    });
    expect(list.value.find((row) => row.domain === 'low.example')).toMatchObject({
      rank: RANK_MIN,
      negativeSignals: 125,
    });
  });

  it('promotes an auto row to user, seeds +1, and never demotes it', () => {
    const store = new SqliteDomainRankStore({ db });
    store.applySignal({ domain: 'example.com', delta: -1, reason: 'blocked' });
    const promoted = store.upsertUserDomain('www.example.com');
    expect(promoted).toMatchObject({
      isOk: true,
      value: {
        domain: 'example.com',
        rank: 0,
        positiveSignals: 1,
        negativeSignals: 1,
        origin: 'user',
      },
    });

    store.applySignal({ domain: 'example.com', delta: -1, reason: 'fetch_failed' });
    const listed = store.list();
    if (!listed.isOk) throw listed.error;
    expect(listed.value[0]?.origin).toBe('user');
  });

  it('silently drops invalid-domain signals', () => {
    const store = new SqliteDomainRankStore({ db });
    expect(
      store.applySignal({
        domain: 'https://example.com',
        delta: 1,
        reason: 'search_result',
      }),
    ).toMatchObject({ isOk: true });
    expect(store.list()).toMatchObject({ isOk: true, value: [] });
  });

  it('orders by rank descending and domain ascending', () => {
    const store = new SqliteDomainRankStore({ db });
    store.applySignal({ domain: 'z.example', delta: 1, reason: 'search_result' });
    store.applySignal({ domain: 'a.example', delta: 1, reason: 'search_result' });
    store.applySignal({ domain: 'best.example', delta: 1, reason: 'search_result' });
    store.applySignal({ domain: 'best.example', delta: 1, reason: 'search_result' });

    const list = store.list();
    if (!list.isOk) throw list.error;
    expect(list.value.map((row) => row.domain)).toEqual(['best.example', 'a.example', 'z.example']);
  });

  it('removes existing rows and reports missing rows', () => {
    const store = new SqliteDomainRankStore({ db });
    store.upsertUserDomain('example.com');
    expect(store.remove('example.com')).toMatchObject({ isOk: true, value: true });
    expect(store.remove('example.com')).toMatchObject({ isOk: true, value: false });
  });
});
