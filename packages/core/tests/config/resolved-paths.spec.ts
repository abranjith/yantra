import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  resolveStorageDirs,
  resolveStorageDirsWithSources,
} from '../../src/config/resolved-paths.js';

describe('@no-llm resolveStorageDirs', () => {
  const home = join('C:', 'users', 'test', '.yantra');

  it('uses environment values before configuration', () => {
    const result = resolveStorageDirsWithSources(
      { YANTRA_DATA_DIR: 'D:\\env-data', YANTRA_CACHE_DIR: 'D:\\env-cache' },
      'paths:\n  data_dir: D:\\config-data\n  cache_dir: D:\\config-cache\n',
      home,
    );
    expect(result).toMatchObject({
      dataDir: 'D:\\env-data',
      cacheDir: 'D:\\env-cache',
      dataSource: 'env:YANTRA_DATA_DIR',
      cacheSource: 'env:YANTRA_CACHE_DIR',
    });
  });

  it('uses absolute config values before defaults', () => {
    expect(
      resolveStorageDirs({}, 'paths:\n  data_dir: D:\\data\n  cache_dir: D:\\cache\n', home),
    ).toEqual({ dataDir: 'D:\\data', cacheDir: 'D:\\cache' });
  });

  it('rejects relative config values and treats empty environment values as unset', () => {
    expect(
      resolveStorageDirs(
        { YANTRA_DATA_DIR: ' ', YANTRA_CACHE_DIR: '' },
        'paths:\n  data_dir: relative\n  cache_dir: also-relative\n',
        home,
      ),
    ).toEqual({ dataDir: join(home, 'data'), cacheDir: join(home, 'cache') });
  });

  it('returns defaults for malformed YAML', () => {
    expect(resolveStorageDirs({}, 'paths: [', home)).toEqual({
      dataDir: join(home, 'data'),
      cacheDir: join(home, 'cache'),
    });
  });
});
