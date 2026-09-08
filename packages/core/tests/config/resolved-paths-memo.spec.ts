import type * as NodeFs from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fsBoundary = vi.hoisted(() => ({ readFileSync: vi.fn() }));

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeFs>()),
  readFileSync: fsBoundary.readFileSync,
}));

import { cacheDir, dataDir, resetPathCache } from '../../src/config/resolved-paths.js';

describe('@no-llm memoized storage accessors', () => {
  const savedHome = process.env.YANTRA_HOME;
  const savedData = process.env.YANTRA_DATA_DIR;
  const savedCache = process.env.YANTRA_CACHE_DIR;

  beforeEach(() => {
    process.env.YANTRA_HOME = join('C:', 'Users', 'memo', '.yantra');
    delete process.env.YANTRA_DATA_DIR;
    delete process.env.YANTRA_CACHE_DIR;
    fsBoundary.readFileSync.mockReset();
    resetPathCache();
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.YANTRA_HOME;
    else process.env.YANTRA_HOME = savedHome;
    if (savedData === undefined) delete process.env.YANTRA_DATA_DIR;
    else process.env.YANTRA_DATA_DIR = savedData;
    if (savedCache === undefined) delete process.env.YANTRA_CACHE_DIR;
    else process.env.YANTRA_CACHE_DIR = savedCache;
    vi.restoreAllMocks();
    resetPathCache();
  });

  it('warns exactly once and returns defaults when the read throws', () => {
    fsBoundary.readFileSync.mockImplementation(() => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    });
    const warnings: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      warnings.push(String(chunk));
      return true;
    }) as never);

    expect(dataDir()).toBe(join(process.env.YANTRA_HOME!, 'data'));
    expect(cacheDir()).toBe(join(process.env.YANTRA_HOME!, 'cache'));
    expect(warnings).toEqual([
      `warning: could not read ${join(process.env.YANTRA_HOME!, 'config.yaml')}; using default storage locations\n`,
    ]);
  });

  it('reads once across accessors and re-reads only after resetPathCache', () => {
    fsBoundary.readFileSync.mockReturnValue(
      'paths:\n  data_dir: D:\\yantra-data\n  cache_dir: D:\\yantra-cache\n',
    );
    expect(dataDir()).toBe('D:\\yantra-data');
    expect(cacheDir()).toBe('D:\\yantra-cache');
    expect(dataDir()).toBe('D:\\yantra-data');
    expect(fsBoundary.readFileSync).toHaveBeenCalledTimes(1);
    resetPathCache();
    expect(cacheDir()).toBe('D:\\yantra-cache');
    expect(fsBoundary.readFileSync).toHaveBeenCalledTimes(2);
  });
});
