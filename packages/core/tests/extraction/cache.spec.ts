import { mkdtemp, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { canonicalBrief, makeBrief } from '@yantra/test-helpers';
import { afterEach, describe, expect, it } from 'vitest';

import { FileSystemAskCache } from '../../src/extraction/cache.js';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'yantra-cache-spec-'));
  tempDirs.push(dir);
  return dir;
}

const brief = makeBrief({ title: 'Cached brief' });

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0, tempDirs.length).map(async (dir) => {
      await import('node:fs/promises').then((fs) => fs.rm(dir, { recursive: true, force: true }));
    }),
  );
});

describe('@no-llm extraction/cache', () => {
  it('round-trips a Brief through put/get', async () => {
    const dir = await makeTempDir();
    const cache = new FileSystemAskCache({ dir, ttlSeconds: 86_400 });

    await cache.put('abc', canonicalBrief);

    await expect(cache.get('abc')).resolves.toEqual(canonicalBrief);
  });

  it('expires stale entries on read', async () => {
    const dir = await makeTempDir();
    let now = new Date('2026-05-11T10:14:00.000Z');
    const cache = new FileSystemAskCache({ dir, ttlSeconds: 10, clock: () => now });

    await cache.put('ttl', brief);
    now = new Date('2026-05-11T10:14:15.000Z');

    await expect(cache.get('ttl')).resolves.toBeNull();
  });

  it('treats legacy version-1 card entries as a miss', async () => {
    const dir = await makeTempDir();
    const cache = new FileSystemAskCache({ dir, ttlSeconds: 86_400 });

    // A pre-cutover cache file shape (version 1, `cards` payload).
    await writeFile(
      join(dir, 'legacy.json'),
      JSON.stringify({
        version: 1,
        query: 'q',
        search_provider: 'duckduckgo',
        utc_day: '2026-05-11',
        created_at: new Date().toISOString(),
        ttl_seconds: 86_400,
        cards: [{ url: 'https://example.com' }],
      }),
      'utf8',
    );

    await expect(cache.get('legacy')).resolves.toBeNull();
  });

  it('evicts oldest files when max size is exceeded', async () => {
    const dir = await makeTempDir();
    const cache = new FileSystemAskCache({ dir, ttlSeconds: 86_400, maxBytes: 2_000 });

    await cache.put('k1', brief);
    await cache.put('k2', brief);
    await cache.put('k3', brief);

    const files = (await readdir(dir)).filter((name) => name.endsWith('.json'));
    const sizes = await Promise.all(
      files.map(async (name) => stat(join(dir, name)).then((entry) => entry.size)),
    );
    const totalSize = sizes.reduce((acc, size) => acc + size, 0);

    expect(totalSize).toBeLessThanOrEqual(2_000);
    expect(files.length).toBeLessThan(3);
  });
});
