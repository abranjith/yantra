import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { defaultConfig } from '../../src/config/load.js';
import { pruneRetention } from '../../src/retention/prune.js';

describe('@no-llm pruneRetention', () => {
  const roots: string[] = [];
  afterEach(async () =>
    Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
  );

  it('keeps only the newest configured corrupt-index backups', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yantra-prune-'));
    roots.push(root);
    const runsPath = join(root, 'runs');
    await mkdir(runsPath);
    for (let index = 0; index < 5; index += 1) {
      const path = join(root, `index.db.corrupt.${index}`);
      await writeFile(path, 'bad');
      await utimes(path, index + 1, index + 1);
    }
    const base = defaultConfig();
    await pruneRetention({
      config: { ...base, retention: { runs_days: 0, corrupt_index_keep: 3 } },
      runsPath,
      indexPath: join(root, 'index.db'),
    });
    expect(
      (await readdir(root)).filter((name) => name.startsWith('index.db.corrupt.')),
    ).toHaveLength(3);
  });

  it('does not prune runs when runs_days is zero', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yantra-prune-'));
    roots.push(root);
    const runsPath = join(root, 'runs');
    await mkdir(join(runsPath, 'old'), { recursive: true });
    const base = defaultConfig();
    await pruneRetention({
      config: { ...base, retention: { ...base.retention, runs_days: 0 } },
      runsPath,
      indexPath: join(root, 'index.db'),
    });
    expect(await readdir(runsPath)).toContain('old');
  });
});
