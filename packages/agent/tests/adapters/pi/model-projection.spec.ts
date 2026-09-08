import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defaultConfig, resetPathCache } from '@yantra/core';
import { afterEach, describe, expect, it } from 'vitest';

import { modelSupportsImageInput } from '../../../src/adapters/pi/environment.js';
import { projectModels } from '../../../src/adapters/pi/model-projection.js';

describe('@no-llm projectModels', () => {
  const roots: string[] = [];
  afterEach(async () =>
    Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
  );

  it('writes a stable Pi shape without credential material', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yantra-models-'));
    roots.push(root);
    const path = join(root, 'pi', 'models.json');
    const base = defaultConfig();
    const canary = 'CANARY-secret-material';
    const config = {
      ...base,
      models: [
        {
          id: 'llama',
          provider: 'ollama',
          base_url: 'http://localhost:11434',
          api_key: { kind: 'env' as const, name: 'OLLAMA_API_KEY' },
          input: ['text' as const, 'image' as const],
        },
      ],
    };
    process.env.OLLAMA_API_KEY = canary;
    await projectModels(config, path);
    const first = await readFile(path, 'utf8');
    await projectModels(config, path);
    expect(await readFile(path, 'utf8')).toBe(first);
    expect(JSON.parse(first)).toMatchObject({
      providers: {
        ollama: {
          baseUrl: 'http://localhost:11434',
          models: [{ id: 'llama', input: ['text', 'image'] }],
        },
      },
    });
    expect(first).toContain('${env:OLLAMA_API_KEY}');
    expect(first).not.toContain(canary);
    delete process.env.OLLAMA_API_KEY;
  });

  it('projects configured image capability before the registry lookup and fails closed on misses', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yantra-model-capability-'));
    roots.push(root);
    const savedHome = process.env.YANTRA_HOME;
    process.env.YANTRA_HOME = root;
    resetPathCache();
    try {
      await writeFile(
        join(root, 'config.yaml'),
        [
          'models:',
          '  - id: vision',
          '    provider: ollama',
          '    base_url: http://localhost:11434',
          '    input: [text, image]',
        ].join('\n'),
      );
      await expect(modelSupportsImageInput('ollama', 'vision')).resolves.toBe(true);
      await expect(modelSupportsImageInput('ollama', 'missing')).resolves.toBe(false);
    } finally {
      if (savedHome === undefined) delete process.env.YANTRA_HOME;
      else process.env.YANTRA_HOME = savedHome;
      resetPathCache();
    }
  });
});
