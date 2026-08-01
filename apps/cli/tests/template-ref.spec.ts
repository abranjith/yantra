import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileTemplateStore } from '@yantra/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TemplateReferenceError, resolveTemplateRef } from '../src/template-ref.js';

function template(name: string, tags: readonly string[] = []): string {
  return `---\nname: ${name}\ntags: [${tags.join(', ')}]\n---\n# {{ title | text }}\n\n{{ sources }}\n`;
}

describe('@no-llm template reference resolution', () => {
  let root: string;
  let cwd: string;
  let store: FileTemplateStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'yantra-template-ref-store-'));
    cwd = await mkdtemp(join(tmpdir(), 'yantra-template-ref-cwd-'));
    store = new FileTemplateStore(root);
    await store.save('weekly', template('weekly', ['work', 'shared']));
    await store.save('shared', template('shared', ['other']));
    await store.save('monthly', template('monthly', ['work', 'shared']));
  });

  afterEach(async () => {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(cwd, { recursive: true, force: true }),
    ]);
  });

  it('honors explicit prefixes and inferred path/name/tag precedence', async () => {
    const path = join(cwd, 'local.md');
    await writeFile(path, '# {{ title | text }}\n\n{{ sources }}\n', 'utf8');

    await expect(resolveTemplateRef(`path:${path}`, { store, cwd })).resolves.toMatchObject({
      source: 'path',
      name: 'local',
    });
    await expect(resolveTemplateRef('./local.md', { store, cwd })).resolves.toMatchObject({
      source: 'path',
    });
    await expect(resolveTemplateRef('shared', { store, cwd })).resolves.toMatchObject({
      source: 'saved',
      name: 'shared',
    });
    await expect(resolveTemplateRef('name:weekly', { store })).resolves.toMatchObject({
      name: 'weekly',
    });
    await expect(resolveTemplateRef('tag:other', { store })).resolves.toMatchObject({
      name: 'shared',
    });
  });

  it('prompts for an ambiguous tag only on a TTY', async () => {
    const choose = vi.fn(() => Promise.resolve('monthly'));
    await expect(
      resolveTemplateRef('tag:work', { store, isTty: true, choose }),
    ).resolves.toMatchObject({ name: 'monthly' });
    expect(choose).toHaveBeenCalledWith(['monthly', 'weekly']);

    await expect(resolveTemplateRef('tag:work', { store, isTty: false })).rejects.toThrow(
      /monthly, weekly/,
    );
  });

  it('reports available names, missing paths, and parse errors as validation failures', async () => {
    await expect(resolveTemplateRef('unknown', { store, isTty: false })).rejects.toMatchObject({
      exitCode: 1,
      message: expect.stringContaining('monthly, shared, weekly'),
    });
    await expect(resolveTemplateRef('./missing.md', { store, cwd })).rejects.toBeInstanceOf(
      TemplateReferenceError,
    );

    const bad = join(cwd, 'bad.md');
    await writeFile(bad, '# {{ broken\n', 'utf8');
    await expect(resolveTemplateRef(bad, { store })).rejects.toThrow(/line 1/i);
  });
});
