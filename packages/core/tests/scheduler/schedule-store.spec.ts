import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  SCHEMA_VERSION,
  currentSchemaVersion,
  runMigrations,
} from '../../src/index-db/migrations.js';
import { SqliteScheduleStore } from '../../src/index-db/schedule-store.js';
import { DatabaseSync } from '../../src/index-db/sqlite.js';

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  runMigrations(db);
  return db;
}

/** Deterministic id + clock so registration rows are reproducible. */
function makeStore(
  db: DatabaseSync,
  ids: string[] = ['ID000000000000000000000001'],
): {
  store: SqliteScheduleStore;
} {
  let i = 0;
  const store = new SqliteScheduleStore({
    db,
    idGen: () => ids[Math.min(i++, ids.length - 1)]!,
    clock: { now: () => new Date('2026-07-05T00:00:00.000Z') },
  });
  return { store };
}

describe('@no-llm SqliteScheduleStore', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = makeDb();
  });

  afterEach(() => {
    db.close();
  });

  it('applies migration v2, creating the schedules table and its index', () => {
    expect(currentSchemaVersion(db)).toBe(SCHEMA_VERSION);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as { name: string }[];
    expect(tables.map((t) => t.name)).toContain('schedules');

    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as {
      name: string;
    }[];
    expect(indexes.map((i) => i.name)).toContain('idx_schedules_enabled_next_fire');
  });

  it('registers a schedule with defaults filled and always on_confirm = pause-and-notify', async () => {
    const { store } = makeStore(db);
    const result = await store.register({
      workflowName: 'demo',
      cronExpr: '*/5 * * * *',
    });
    if (!result.isOk) throw new Error('register failed');

    expect(result.value).toMatchObject({
      id: 'ID000000000000000000000001',
      workflowName: 'demo',
      cronExpr: '*/5 * * * *',
      params: {},
      notifyTarget: 'desktop',
      onConfirm: 'pause-and-notify',
      enabled: true,
      createdAt: '2026-07-05T00:00:00.000Z',
      lastFireAt: null,
      lastRunId: null,
      lastStatus: null,
    });
  });

  it('round-trips a registered schedule through list()', async () => {
    const { store } = makeStore(db);
    const registered = await store.register({
      workflowName: 'demo',
      cronExpr: '*/5 * * * *',
      params: { month: '2026-04' },
      notifyTarget: 'file',
      nextFireAt: '2026-07-05T00:05:00.000Z',
    });
    if (!registered.isOk) throw new Error('register failed');

    const listed = await store.list();
    if (!listed.isOk) throw new Error('list failed');
    expect(listed.value).toHaveLength(1);
    expect(listed.value[0]).toMatchObject({
      id: registered.value.id,
      workflowName: 'demo',
      params: { month: '2026-04' },
      notifyTarget: 'file',
      nextFireAt: '2026-07-05T00:05:00.000Z',
    });
  });

  it('reads a single schedule by id and returns null for an unknown id', async () => {
    const { store } = makeStore(db);
    const reg = await store.register({ workflowName: 'demo', cronExpr: '0 * * * *' });
    if (!reg.isOk) throw new Error('register failed');

    const got = await store.get(reg.value.id);
    if (!got.isOk) throw new Error('get failed');
    expect(got.value?.id).toBe(reg.value.id);

    const missing = await store.get('NOPE');
    if (!missing.isOk) throw new Error('get failed');
    expect(missing.value).toBeNull();
  });

  it('lists only enabled schedules', async () => {
    const { store } = makeStore(db, ['ID1', 'ID2']);
    const a = await store.register({ workflowName: 'a', cronExpr: '0 * * * *' });
    const b = await store.register({ workflowName: 'b', cronExpr: '0 * * * *' });
    if (!a.isOk || !b.isOk) throw new Error('register failed');

    await store.setEnabled(b.value.id, false);

    const enabled = await store.listEnabled();
    if (!enabled.isOk) throw new Error('listEnabled failed');
    expect(enabled.value.map((s) => s.workflowName)).toEqual(['a']);
  });

  it('removes a schedule and reports whether a row was deleted', async () => {
    const { store } = makeStore(db);
    const reg = await store.register({ workflowName: 'demo', cronExpr: '0 * * * *' });
    if (!reg.isOk) throw new Error('register failed');

    const removed = await store.remove(reg.value.id);
    if (!removed.isOk) throw new Error('remove failed');
    expect(removed.value).toBe(true);

    const removedAgain = await store.remove(reg.value.id);
    if (!removedAgain.isOk) throw new Error('remove failed');
    expect(removedAgain.value).toBe(false);
  });

  it('records a fire outcome on the schedule row', async () => {
    const { store } = makeStore(db);
    const reg = await store.register({ workflowName: 'demo', cronExpr: '0 * * * *' });
    if (!reg.isOk) throw new Error('register failed');

    const marked = await store.markFire(reg.value.id, {
      lastFireAt: '2026-07-05T01:00:00.000Z',
      lastRunId: 'run-123',
      lastStatus: 'succeeded',
      nextFireAt: '2026-07-05T02:00:00.000Z',
    });
    if (!marked.isOk) throw new Error('markFire failed');

    const got = await store.get(reg.value.id);
    if (!got.isOk || got.value === null) throw new Error('get failed');
    expect(got.value).toMatchObject({
      lastFireAt: '2026-07-05T01:00:00.000Z',
      lastRunId: 'run-123',
      lastStatus: 'succeeded',
      nextFireAt: '2026-07-05T02:00:00.000Z',
    });
  });

  it('records a pending-confirmation fire status (parked run)', async () => {
    const { store } = makeStore(db);
    const reg = await store.register({ workflowName: 'demo', cronExpr: '0 * * * *' });
    if (!reg.isOk) throw new Error('register failed');

    await store.markFire(reg.value.id, {
      lastFireAt: '2026-07-05T01:00:00.000Z',
      lastRunId: 'run-abc',
      lastStatus: 'pending-confirmation',
      nextFireAt: null,
    });

    const got = await store.get(reg.value.id);
    if (!got.isOk || got.value === null) throw new Error('get failed');
    expect(got.value.lastStatus).toBe('pending-confirmation');
  });

  it('rejects an on_confirm value other than pause-and-notify at the DB layer', () => {
    // The store never writes another value; this asserts the CHECK constraint
    // is the fourth defense layer (plan §6) — a direct malformed insert fails.
    expect(() =>
      db
        .prepare(
          `INSERT INTO schedules
             (id, workflow_name, cron_expr, params_json, notify_target, on_confirm,
              enabled, created_at)
           VALUES ('x','w','0 * * * *','{}','desktop','auto-confirm',1,'2026-07-05T00:00:00Z')`,
        )
        .run(),
    ).toThrow();
  });

  it('rejects an unknown notify_target at the DB layer', () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO schedules
             (id, workflow_name, cron_expr, params_json, notify_target, on_confirm,
              enabled, created_at)
           VALUES ('x','w','0 * * * *','{}','sms','pause-and-notify',1,'2026-07-05T00:00:00Z')`,
        )
        .run(),
    ).toThrow();
  });

  it('degrades to defensive empty params when params_json is malformed on disk', async () => {
    const { store } = makeStore(db);
    const reg = await store.register({ workflowName: 'demo', cronExpr: '0 * * * *' });
    if (!reg.isOk) throw new Error('register failed');
    // Corrupt the stored JSON directly.
    db.prepare('UPDATE schedules SET params_json = ? WHERE id = ?').run('not json', reg.value.id);

    const got = await store.get(reg.value.id);
    if (!got.isOk || got.value === null) throw new Error('get failed');
    expect(got.value.params).toEqual({});
  });
});
