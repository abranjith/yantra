import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { uniqueTempPath, writeFileAtomic } from '../../src/fs/atomic-write.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, open: vi.fn(actual.open), rename: vi.fn(actual.rename) };
});
const actual = await vi.importActual<typeof fs>('node:fs/promises');

describe('@no-llm atomic file publication', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'yantra-atomic-'));
    vi.mocked(fs.open).mockClear().mockImplementation(actual.open);
    vi.mocked(fs.rename).mockClear().mockImplementation(actual.rename);
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('uses exclusive distinct sibling staging files for concurrent writers', async () => {
    const path = join(root, 'nested', 'document.json');
    await Promise.all([writeFileAtomic(path, 'first'), writeFileAtomic(path, 'second')]);
    expect(['first', 'second']).toContain(await fs.readFile(path, 'utf8'));
    const paths = vi.mocked(fs.open).mock.calls.map((call) => String(call[0]));
    expect(new Set(paths).size).toBe(2);
    for (const call of vi.mocked(fs.open).mock.calls) {
      expect(call[0]).toMatch(/document\.json\.\d+\.[0-9a-f]{8}\.tmp$/);
      expect(call[1]).toBe('wx');
    }
    expect(await fs.readdir(join(root, 'nested'))).toEqual(['document.json']);
  });

  it('removes a partially written staging file on write failure and preserves the old file', async () => {
    const path = join(root, 'document');
    await fs.writeFile(path, 'old');
    const failure = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      const handle = await actual.open(...args);
      vi.spyOn(handle, 'writeFile').mockRejectedValueOnce(failure);
      return handle;
    });
    await expect(writeFileAtomic(path, 'new')).rejects.toBe(failure);
    expect(await fs.readFile(path, 'utf8')).toBe('old');
    expect(await fs.readdir(root)).toEqual(['document']);
  });

  it('cleans up staging on rename failure', async () => {
    const failure = Object.assign(new Error('rename denied'), { code: 'EACCES' });
    vi.mocked(fs.rename).mockRejectedValueOnce(failure);
    await expect(writeFileAtomic(join(root, 'document'), 'new')).rejects.toBe(failure);
    expect(await fs.readdir(root)).toEqual([]);
  });

  it('does not delete another writer staging file when exclusive create fails', async () => {
    const failure = Object.assign(new Error('already exists'), { code: 'EEXIST' });
    vi.mocked(fs.open).mockRejectedValueOnce(failure);
    await expect(writeFileAtomic(join(root, 'document'), 'new')).rejects.toBe(failure);
    expect(vi.mocked(fs.rename)).not.toHaveBeenCalled();
  });

  it('flushes the staged file when fsync is requested', async () => {
    const synced = vi.fn();
    vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      const handle = await actual.open(...args);
      vi.spyOn(handle, 'sync').mockImplementation(async () => {
        synced();
      });
      return handle;
    });
    await writeFileAtomic(join(root, 'manifest'), new Uint8Array([1, 2, 3]), { fsync: true });
    expect(synced).toHaveBeenCalledOnce();
    expect(await fs.readFile(join(root, 'manifest'))).toEqual(Buffer.from([1, 2, 3]));
  });

  it.skipIf(process.platform === 'win32')(
    'sets requested owner-only file permissions',
    async () => {
      const path = join(root, 'private');
      await writeFileAtomic(path, 'private', { mode: 0o600 });
      expect((await fs.stat(path)).mode & 0o777).toBe(0o600);
    },
  );

  it.skipIf(process.platform !== 'win32')(
    'retries transient Windows rename EPERM a bounded number of times',
    async () => {
      const failure = Object.assign(new Error('temporarily open'), { code: 'EPERM' });
      vi.mocked(fs.rename).mockRejectedValueOnce(failure).mockRejectedValueOnce(failure);
      await writeFileAtomic(join(root, 'document'), 'new');
      expect(vi.mocked(fs.rename)).toHaveBeenCalledTimes(3);
      expect(await fs.readdir(root)).toEqual(['document']);
    },
  );

  it('preserves the file prefix in the temporary path', () => {
    expect(uniqueTempPath(join(root, 'document'))).toMatch(/document\.\d+\.[a-f0-9]{8}\.tmp$/);
  });
});
