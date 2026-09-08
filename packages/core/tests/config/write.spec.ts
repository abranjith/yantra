import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config/load.js';
import { setConfigKey, unsetConfigKey } from '../../src/config/write.js';

describe('@no-llm config writer', () => {
  const roots: string[] = [];
  afterEach(async () =>
    Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
  );

  async function fixture(contents: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'yantra-write-'));
    roots.push(root);
    const path = join(root, 'config.yaml');
    await writeFile(path, contents);
    return path;
  }

  it('preserves comments and key order while setting a value', async () => {
    const path = await fixture('# hand-written\nversion: 1\nretention:\n  runs_days: 30\n');
    await setConfigKey('retention.runs_days', 7, path);
    const text = await readFile(path, 'utf8');
    expect(text).toContain('# hand-written');
    expect(text.indexOf('version:')).toBeLessThan(text.indexOf('retention:'));
    expect(text).toContain('runs_days: 7');
  });

  it('leaves the file byte-identical when a candidate is invalid', async () => {
    const path = await fixture('version: 1\nretention:\n  runs_days: 30\n');
    const before = await readFile(path, 'utf8');
    await expect(setConfigKey('retention.runs_days', -1, path)).rejects.toThrow();
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  it('allows unset values to return to schema defaults', async () => {
    const path = await fixture('version: 1\nretention:\n  runs_days: 7\n');
    await unsetConfigKey('retention.runs_days', path);
    const loaded = await loadConfig(path);
    expect(loaded.isOk && loaded.value.retention.runs_days).toBe(30);
  });
});
