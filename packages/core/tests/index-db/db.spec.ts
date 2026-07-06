import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getMeta, openIndexDb } from '../../src/index-db/db.js';
import { currentSchemaVersion, SCHEMA_VERSION } from '../../src/index-db/migrations.js';

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

describe('@no-llm openIndexDb', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'yantra-indexdb-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates the schema at the current version on a fresh open', async () => {
    const path = join(dir, 'index.db');

    const { db, wasCorrupt } = await openIndexDb({ path, logger: silentLogger });

    expect(wasCorrupt).toBe(false);
    expect(currentSchemaVersion(db)).toBe(SCHEMA_VERSION);
    expect(getMeta(db, 'db_schema_version')).toBe(String(SCHEMA_VERSION));

    // All four v1 tables exist.
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain('history');
    expect(names).toContain('preferences');
    expect(names).toContain('rate_limits');
    expect(names).toContain('meta');

    db.close();
  });

  it('is idempotent across reopen — no duplicate migration, data preserved', async () => {
    const path = join(dir, 'index.db');

    const first = await openIndexDb({ path });
    first.db
      .prepare(
        `INSERT INTO history (run_id, task_type, intent_text, status, started_at)
         VALUES ('r1', 'ask', 'hello', 'succeeded', '2026-07-01T00:00:00.000Z')`,
      )
      .run();
    first.db.close();

    const second = await openIndexDb({ path });
    expect(second.wasCorrupt).toBe(false);
    expect(currentSchemaVersion(second.db)).toBe(SCHEMA_VERSION);
    const count = second.db.prepare('SELECT COUNT(*) AS n FROM history').get() as { n: number };
    expect(Number(count.n)).toBe(1);
    second.db.close();
  });

  it('detects a corrupt file, moves it aside, and rebuilds a fresh schema', async () => {
    const path = join(dir, 'index.db');
    // A file that is not a valid SQLite database.
    await writeFile(path, 'this is definitely not sqlite', 'utf8');

    let rebuilt = false;
    const { db, wasCorrupt } = await openIndexDb({
      path,
      logger: silentLogger,
      rebuild: () => {
        rebuilt = true;
      },
    });

    expect(wasCorrupt).toBe(true);
    expect(rebuilt).toBe(true);
    expect(currentSchemaVersion(db)).toBe(SCHEMA_VERSION);
    expect(getMeta(db, 'last_rebuilt_at')).not.toBeNull();

    // The bad file was preserved with a .corrupt.* suffix.
    const siblings = await readdir(dir);
    expect(siblings.some((name) => name.startsWith('index.db.corrupt.'))).toBe(true);

    db.close();
  });

  it('sets 0600 permissions on the db file (POSIX only)', async () => {
    if (process.platform === 'win32') {
      return; // permission bits are not meaningful on Windows
    }
    const path = join(dir, 'index.db');
    const { db } = await openIndexDb({ path });
    const info = await stat(path);
    expect(info.mode & 0o777).toBe(0o600);
    db.close();
  });

  it('rebuilds an empty schema when a corrupt db has no rebuild hook', async () => {
    const path = join(dir, 'index.db');
    await writeFile(path, 'corrupt', 'utf8');

    const { db, wasCorrupt } = await openIndexDb({ path, logger: silentLogger });

    expect(wasCorrupt).toBe(true);
    const count = db.prepare('SELECT COUNT(*) AS n FROM history').get() as { n: number };
    expect(Number(count.n)).toBe(0);
    db.close();
  });

  it('creates the parent directory when it does not yet exist', async () => {
    const nested = join(dir, 'a', 'b', 'index.db');
    const { db } = await openIndexDb({ path: nested });
    await expect(stat(nested)).resolves.toBeTruthy();
    db.close();
    // sanity: the nested dir was created
    await mkdir(join(dir, 'a'), { recursive: true });
  });
});
