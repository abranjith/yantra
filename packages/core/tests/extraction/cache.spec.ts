import { mkdtemp, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { FileSystemAskCache } from '../../src/extraction/cache.js';
import type { AskCard } from '../../src/extraction/types.js';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'yantra-cache-spec-'));
  tempDirs.push(dir);
  return dir;
}

const card: AskCard = {
  url: 'https://example.com/story',
  title: 'Story',
  source: 'example.com',
  fetchedAt: '2026-05-11T10:14:00.000Z',
  publishedAt: null,
  summary: 'Summary',
  summaryKind: 'rule-based',
  quotedSnippet: 'Snippet',
  tags: ['news'],
  notice: null,
};

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0, tempDirs.length).map(async (dir) => {
      await import('node:fs/promises').then((fs) => fs.rm(dir, { recursive: true, force: true }));
    }),
  );
});

describe('@no-llm extraction/cache', () => {
  it('round-trips cards through put/get', async () => {
    const dir = await makeTempDir();
    const cache = new FileSystemAskCache({ dir, ttlSeconds: 86_400 });

    await cache.put('abc', [card]);

    await expect(cache.get('abc')).resolves.toEqual([card]);
  });

  it('expires stale entries on read', async () => {
    const dir = await makeTempDir();
    let now = new Date('2026-05-11T10:14:00.000Z');
    const cache = new FileSystemAskCache({
      dir,
      ttlSeconds: 10,
      clock: () => now,
    });

    await cache.put('ttl', [card]);
    now = new Date('2026-05-11T10:14:15.000Z');

    await expect(cache.get('ttl')).resolves.toBeNull();
  });

  it('evicts oldest files when max size is exceeded', async () => {
    const dir = await makeTempDir();
    const cache = new FileSystemAskCache({ dir, ttlSeconds: 86_400, maxBytes: 600 });

    await cache.put('k1', [card]);
    await cache.put('k2', [card]);
    await cache.put('k3', [card]);

    const files = (await readdir(dir)).filter((name) => name.endsWith('.json'));
    const totalSize = (
      await Promise.all(
        files.map(async (name) => stat(join(dir, name)).then((entry) => entry.size)),
      )
    ).reduce((acc, size) => acc + size, 0);

    expect(totalSize).toBeLessThanOrEqual(600);
    expect(files.length).toBeLessThan(3);
  });
});
