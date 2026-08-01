import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  FileTemplateStore,
  TemplateCollisionError,
  TemplateStoreError,
} from '../../src/report-template/store.js';

const template = (name: string, body = '{{ summary }}'): string =>
  `---\nname: ${name}\ntags: [work]\n---\n# Report\n${body}\n`;

describe('@no-llm FileTemplateStore', () => {
  let root: string;
  let store: FileTemplateStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'yantra-templates-'));
    store = new FileTemplateStore(join(root, 'library'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('round-trips save, load, list, exists, and remove', async () => {
    const raw = template('weekly');
    const path = await store.save('weekly', raw);
    expect(path).toBe(join(root, 'library', 'weekly.md'));
    await expect(store.load('weekly')).resolves.toBe(raw);
    await expect(store.exists('weekly')).resolves.toBe(true);
    await expect(store.list()).resolves.toMatchObject([
      { name: 'weekly', tags: ['work'], slotCount: 1, path },
    ]);
    await store.remove('weekly');
    await expect(store.exists('weekly')).resolves.toBe(false);
  });

  it('rejects collisions unless force is true', async () => {
    await store.save('weekly', template('weekly', '{{ first }}'));
    await expect(store.save('weekly', template('weekly', '{{ second }}'))).rejects.toBeInstanceOf(
      TemplateCollisionError,
    );
    await store.save('weekly', template('weekly', '{{ second }}'), { force: true });
    await expect(store.load('weekly')).resolves.toContain('{{ second }}');
  });

  it('returns an empty list for a missing directory', async () => {
    await expect(store.list()).resolves.toEqual([]);
  });

  it('skips non-Markdown, invalid names, and unparsable templates', async () => {
    const library = join(root, 'library');
    await store.save('valid', template('valid'));
    await writeFile(join(library, 'notes.txt'), 'not a template', 'utf8');
    await writeFile(join(library, 'Broken Name.md'), template('broken'), 'utf8');
    await writeFile(join(library, 'broken.md'), '{{ malformed', 'utf8');
    expect((await store.list()).map((entry) => entry.name)).toEqual(['valid']);
  });

  it('sorts by mtime descending with a stable name tie-break', async () => {
    const oldPath = await store.save('old', template('old'));
    const newPath = await store.save('new', template('new'));
    await utimes(oldPath, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
    await utimes(newPath, new Date('2026-02-01T00:00:00Z'), new Date('2026-02-01T00:00:00Z'));
    expect((await store.list()).map((entry) => entry.name)).toEqual(['new', 'old']);
  });

  it.each(['', '../escape', 'Uppercase', 'space name', 'a'.repeat(65)])(
    'rejects invalid name %j before touching disk',
    async (name) => {
      await expect(store.save(name, template('valid'))).rejects.toBeInstanceOf(TemplateStoreError);
    },
  );
});
