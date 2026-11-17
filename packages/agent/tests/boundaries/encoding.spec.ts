import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const CORRUPT_PREFIX = Buffer.from([0xc3, 0xa2, 0xe2, 0x82, 0xac]);
async function corruptFiles(root: string): Promise<string[]> {
  const hits: string[] = [];
  // Include new source files, while excluding ignored reports and stale worktrees.
  const { stdout } = await promisify(execFile)(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: root, maxBuffer: 8 * 1024 * 1024 },
  );
  for (const name of new Set(stdout.split('\0').filter(Boolean))) {
    if (!/\.(?:ts|tsx|md|json|ya?ml)$/u.test(name)) continue;
    const path = join(root, name);
    if ((await readFile(path)).includes(CORRUPT_PREFIX)) hits.push(path);
  }
  return hits;
}
describe('@no-llm repository UTF-8 punctuation', () => {
  it('detects a double-encoded punctuation byte sequence', () => {
    expect(
      Buffer.concat([Buffer.from('before'), CORRUPT_PREFIX, Buffer.from('after')]).includes(
        CORRUPT_PREFIX,
      ),
    ).toBe(true);
    expect(Buffer.from('before — after').includes(CORRUPT_PREFIX)).toBe(false);
  });
  it('contains no double-encoded punctuation in source or documentation', async () => {
    expect(await corruptFiles(resolve(import.meta.dirname, '../../../..'))).toEqual([]);
  }, 30000);
});
