// @no-llm
/**
 * The `yantra-build-id` plugin (FEAT-065 TASK-012): the ID is stable for
 * identical sources, changes with any asset, and `build-id.json` equals the
 * meta tag in the built `index.html`.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { build } from 'vite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BUILD_ID_META, buildIdFrom, yantraBuildId } from '../build/yantra-build-id.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'yantra-build-id-'));
  writeFileSync(
    join(root, 'index.html'),
    '<!doctype html><html><head><script type="module" src="/main.js"></script></head><body></body></html>',
  );
  writeFileSync(join(root, 'main.js'), 'document.body.textContent = "one";\n');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function buildFixture(outDir: string): Promise<{ id: string; meta: string | undefined }> {
  await build({
    root,
    logLevel: 'silent',
    configFile: false,
    plugins: [yantraBuildId()],
    build: { outDir, emptyOutDir: true, modulePreload: { polyfill: false } },
  });
  const { build_id: id } = JSON.parse(readFileSync(join(outDir, 'build-id.json'), 'utf8')) as {
    build_id: string;
  };
  const html = readFileSync(join(outDir, 'index.html'), 'utf8');
  const meta = new RegExp(`<meta name="${BUILD_ID_META}" content="([^"]+)"`, 'u').exec(html)?.[1];
  return { id, meta };
}

describe('buildIdFrom', () => {
  it('hashes only assets/ names, independent of order', () => {
    const a = buildIdFrom(['assets/a-1.js', 'index.html', 'assets/b-2.css']);
    const b = buildIdFrom(['assets/b-2.css', 'assets/a-1.js', 'build-id.json']);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('changes when any asset name changes', () => {
    expect(buildIdFrom(['assets/a-1.js'])).not.toBe(buildIdFrom(['assets/a-2.js']));
  });
});

describe('a real build', () => {
  it('writes build-id.json equal to the index.html meta tag', async () => {
    const { id, meta } = await buildFixture(join(root, 'out'));
    expect(meta).toBe(id);
  }, 60_000);

  it('keeps the ID across a rebuild with no changes and changes it when a source changes', async () => {
    // Act
    const first = await buildFixture(join(root, 'out-1'));
    const again = await buildFixture(join(root, 'out-2'));
    writeFileSync(join(root, 'main.js'), 'document.body.textContent = "two";\n');
    const changed = await buildFixture(join(root, 'out-3'));

    // Assert
    expect(again.id).toBe(first.id);
    expect(changed.id).not.toBe(first.id);
  }, 60_000);
});
