import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PNG } from 'pngjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  baselinePath,
  compareToBaseline,
  defaultVisualOptions,
  hasBaseline,
  MAX_DIFF_RATIO,
  type VisualOptions,
} from './visual.js';

/** A solid gray image with `changed` pixels (from the top-left) set to red. */
function image(width: number, height: number, changed = 0): Uint8Array {
  const png = new PNG({ width, height });
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const offset = pixel * 4;
    const red = pixel < changed;
    png.data[offset] = red ? 255 : 128;
    png.data[offset + 1] = red ? 0 : 128;
    png.data[offset + 2] = red ? 0 : 128;
    png.data[offset + 3] = 255;
  }
  return PNG.sync.write(png);
}

describe('@no-llm Drshya visual baselines', () => {
  let root: string;
  let options: VisualOptions;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'drshya-visual-'));
    options = { baselineDir: join(root, 'baselines'), outDir: join(root, 'out'), update: false };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('writes the baseline in update mode', async () => {
    const png = image(10, 10);

    const result = await compareToBaseline('entry--light--glass', png, {
      ...options,
      update: true,
    });

    expect(result.status).toBe('written');
    expect(await readFile(baselinePath('entry--light--glass', options))).toEqual(Buffer.from(png));
    expect(hasBaseline('entry--light--glass', options)).toBe(true);
  });

  it('reports a missing baseline and writes the actual image for review', async () => {
    const result = await compareToBaseline('entry--dark--solid', image(10, 10), options);

    expect(result.status).toBe('missing');
    expect(result.status === 'missing' && existsSync(result.actualPath)).toBe(true);
    expect(existsSync(join(options.baselineDir, 'entry--dark--solid.png'))).toBe(false);
  });

  it('passes identical images', async () => {
    await compareToBaseline('same', image(100, 100), { ...options, update: true });

    const result = await compareToBaseline('same', image(100, 100), options);

    expect(result).toEqual({ status: 'match', diffRatio: 0 });
    expect(existsSync(options.outDir)).toBe(false);
  });

  it('tolerates differences up to the limit', async () => {
    await compareToBaseline('tolerated', image(100, 100), { ...options, update: true });

    // 10 of 10,000 pixels is exactly 0.1%.
    const result = await compareToBaseline('tolerated', image(100, 100, 10), options);

    expect(result.status).toBe('match');
    expect(result.status === 'match' && result.diffRatio).toBe(MAX_DIFF_RATIO);
  });

  it('fails a 1% change and writes the actual and diff images', async () => {
    await compareToBaseline('changed', image(100, 100), { ...options, update: true });

    const result = await compareToBaseline('changed', image(100, 100, 100), options);

    expect(result.status).toBe('mismatch');
    if (result.status !== 'mismatch') {
      return;
    }
    expect(result.diffRatio).toBeCloseTo(0.01, 6);
    expect(result.reason).toContain('1.000% of pixels differ');
    expect(existsSync(result.actualPath)).toBe(true);
    expect(result.diffPath !== null && existsSync(result.diffPath)).toBe(true);
  });

  it('fails a size change without a diff image', async () => {
    await compareToBaseline('resized', image(100, 100), { ...options, update: true });

    const result = await compareToBaseline('resized', image(100, 101), options);

    expect(result.status).toBe('mismatch');
    expect(result.status === 'mismatch' && result.diffPath).toBeNull();
    expect(result.status === 'mismatch' && result.reason).toContain('size 100x101');
  });

  it('keeps baselines per platform', () => {
    expect(defaultVisualOptions('linux').baselineDir).toMatch(/baselines[\\/]linux$/u);
    expect(defaultVisualOptions('win32').baselineDir).toMatch(/baselines[\\/]win32$/u);
  });
});
