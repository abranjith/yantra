import { readFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';

import { describe, expect, it } from 'vitest';

const CORRUPT_PREFIX = Buffer.from([0xc3, 0xa2, 0xe2, 0x82, 0xac]);
const SKIP = new Set(['node_modules', 'dist', '.turbo', 'coverage', '.git', '.worktrees']);
async function corruptFiles(root: string): Promise<string[]> {
  const hits: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) hits.push(...(await corruptFiles(path)));
    else if (
      /\.(?:ts|md|json|yaml)$/u.test(entry.name) &&
      (await readFile(path)).includes(CORRUPT_PREFIX)
    )
      hits.push(path);
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
