import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runMigrations } from '../../src/index-db/migrations.js';
import { SqlitePreferenceStore } from '../../src/index-db/preference-store.js';
import { DatabaseSync } from '../../src/index-db/sqlite.js';

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  runMigrations(db);
  return db;
}

describe('@no-llm SqlitePreferenceStore', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = makeDb();
  });

  afterEach(() => {
    db.close();
  });

  it('sets and reads a user preference (approved by default)', async () => {
    const store = new SqlitePreferenceStore({ db });
    await store.set('defaults.detail', 'full');

    const got = await store.get('defaults.detail');
    if (!got.isOk) throw new Error('get failed');
    expect(got.value).toMatchObject({
      key: 'defaults.detail',
      value: 'full',
      source: 'user',
      approved: true,
    });
  });

  it('upserts on the same key (no duplicate rows)', async () => {
    const store = new SqlitePreferenceStore({ db });
    await store.set('defaults.detail', 'full');
    await store.set('defaults.detail', 'overview');
    const list = await store.list();
    if (!list.isOk) throw new Error('list failed');
    expect(list.value).toHaveLength(1);
    expect(list.value[0]?.value).toBe('overview');
  });

  it('starts learned rows unapproved and approves them explicitly', async () => {
    const store = new SqlitePreferenceStore({ db });
    await store.set('personalization.favorite_retailers', ['amazon'], { source: 'learned' });

    const before = await store.get('personalization.favorite_retailers');
    if (!before.isOk) throw new Error('get failed');
    expect(before.value?.approved).toBe(false);

    const approved = await store.approve('personalization.favorite_retailers');
    expect(approved.isOk).toBe(true);
    if (approved.isOk) expect(approved.value).toBe(true);

    const after = await store.get('personalization.favorite_retailers');
    if (!after.isOk) throw new Error('get failed');
    expect(after.value?.approved).toBe(true);
  });

  it('forget deletes the row (privacy control)', async () => {
    const store = new SqlitePreferenceStore({ db });
    await store.set('locale.units', 'imperial');
    const forgotten = await store.forget('locale.units');
    expect(forgotten.isOk).toBe(true);
    if (forgotten.isOk) expect(forgotten.value).toBe(true);
    const got = await store.get('locale.units');
    if (got.isOk) expect(got.value).toBeNull();
  });

  it('forget returns false for a key that was never set', async () => {
    const store = new SqlitePreferenceStore({ db });
    const forgotten = await store.forget('locale.units');
    if (forgotten.isOk) expect(forgotten.value).toBe(false);
  });
});

describe('@no-llm SqlitePreferenceStore.effective (merge precedence)', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = makeDb();
  });

  afterEach(() => {
    db.close();
  });

  const yaml = new Map<string, unknown>([
    ['defaults.detail', 'standard'],
    ['locale.units', 'metric'],
  ]);

  it('yaml (user layer) wins over a learned DB row', async () => {
    const store = new SqlitePreferenceStore({ db });
    await store.set('defaults.detail', 'overview', { source: 'learned' });

    const effective = await store.effective(yaml);
    if (!effective.isOk) throw new Error('effective failed');
    const detail = effective.value.get('defaults.detail');
    expect(detail?.value).toBe('standard');
    expect(detail?.provenance).toBe('profile.yaml');
  });

  it('an explicit user set overrides the yaml default', async () => {
    const store = new SqlitePreferenceStore({ db });
    await store.set('defaults.detail', 'full', { source: 'user' });

    const effective = await store.effective(yaml);
    if (!effective.isOk) throw new Error('effective failed');
    const detail = effective.value.get('defaults.detail');
    expect(detail?.value).toBe('full');
    expect(detail?.provenance).toBe('index.db');
    expect(detail?.source).toBe('user');
  });

  it('learned rows fill keys the yaml layer does not cover', async () => {
    const store = new SqlitePreferenceStore({ db });
    await store.set('personalization.interests', ['ai'], { source: 'learned' });

    const effective = await store.effective(yaml);
    if (!effective.isOk) throw new Error('effective failed');
    const interests = effective.value.get('personalization.interests');
    expect(interests?.value).toEqual(['ai']);
    expect(interests?.approved).toBe(false);
    expect(interests?.provenance).toBe('index.db');
  });
});
