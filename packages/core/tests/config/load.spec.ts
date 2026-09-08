import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { defaultConfig, loadConfig } from '../../src/config/load.js';

describe('@no-llm loadConfig', () => {
  const roots: string[] = [];
  afterEach(async () =>
    Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
  );

  async function pathFor(contents?: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'yantra-config-'));
    roots.push(root);
    const path = join(root, 'config.yaml');
    if (contents !== undefined) await writeFile(path, contents);
    return path;
  }

  it('loads an empty file as complete defaults', async () => {
    const result = await loadConfig(await pathFor(''));
    expect(result).toEqual({ isOk: true, value: defaultConfig() });
  });

  it('loads a missing file as complete defaults', async () => {
    const result = await loadConfig(await pathFor());
    expect(result).toEqual({ isOk: true, value: defaultConfig() });
  });

  it('reports malformed YAML with the file path', async () => {
    const path = await pathFor('paths: [');
    const result = await loadConfig(path);
    expect(result.isOk).toBe(false);
    if (!result.isOk) expect(result.error.message).toContain(path);
  });

  it('names unknown keys and suggests their nearest sibling', async () => {
    const result = await loadConfig(await pathFor('retention:\n  runsDay: 2\n'));
    expect(result.isOk).toBe(false);
    if (!result.isOk) {
      expect(result.error.issues[0]).toMatchObject({
        keyPath: 'retention.runsDay',
        suggestion: 'runs_days',
      });
    }
  });
});
