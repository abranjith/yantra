/**
 * Visual baselines for the Drshya gallery (spec S6).
 *
 * Baselines are per platform (`baselines/<process.platform>/<name>.png`)
 * because font rasterization differs per OS; only Linux is required in CI. On
 * a mismatch or a missing baseline the actual image (and a diff, when sizes
 * match) is written to `.out/`, which CI uploads, so a Linux baseline can be
 * committed from any machine.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

const here = dirname(fileURLToPath(import.meta.url));

export const BASELINE_ROOT = join(here, 'baselines');
export const OUT_DIR = join(here, '.out');

/** The pixel-match tolerance per pixel (pixelmatch's own scale). */
export const PIXEL_THRESHOLD = 0.1;
/** At most 0.1% of pixels may differ. */
export const MAX_DIFF_RATIO = 0.001;

export interface VisualOptions {
  readonly baselineDir: string;
  readonly outDir: string;
  /** Write the actual image as the new baseline instead of comparing. */
  readonly update: boolean;
}

export type VisualResult =
  | { readonly status: 'match'; readonly diffRatio: number }
  | {
      readonly status: 'mismatch';
      readonly diffRatio: number;
      readonly actualPath: string;
      readonly diffPath: string | null;
      readonly reason: string;
    }
  | { readonly status: 'missing'; readonly actualPath: string; readonly baselinePath: string }
  | { readonly status: 'written'; readonly baselinePath: string };

/** The default options: this platform's baselines, `UPDATE_DRSHYA_BASELINES=1` updates. */
export function defaultVisualOptions(platform: string = process.platform): VisualOptions {
  return {
    baselineDir: join(BASELINE_ROOT, platform),
    outDir: OUT_DIR,
    update: process.env.UPDATE_DRSHYA_BASELINES === '1',
  };
}

/** Where a baseline lives, e.g. `baselines/linux/button--dark--glass.png`. */
export function baselinePath(name: string, options: VisualOptions): string {
  return resolve(options.baselineDir, `${name}.png`);
}

/** Whether a baseline exists, checked synchronously so tests can decide at collection. */
export function hasBaseline(name: string, options: VisualOptions): boolean {
  return existsSync(baselinePath(name, options));
}

async function writeOut(path: string, data: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
}

/**
 * Compares a PNG against its baseline. In update mode it writes the baseline
 * and reports `written`. Never throws on a visual difference: the caller
 * decides whether `missing` or `mismatch` fails on this platform.
 */
export async function compareToBaseline(
  name: string,
  png: Uint8Array,
  options: VisualOptions,
): Promise<VisualResult> {
  const expectedPath = baselinePath(name, options);
  const actualPath = resolve(options.outDir, `${name}.actual.png`);

  if (options.update) {
    await writeOut(expectedPath, png);
    return { status: 'written', baselinePath: expectedPath };
  }
  if (!existsSync(expectedPath)) {
    await writeOut(actualPath, png);
    return { status: 'missing', actualPath, baselinePath: expectedPath };
  }

  const expected = PNG.sync.read(await readFile(expectedPath));
  const actual = PNG.sync.read(Buffer.from(png));
  if (expected.width !== actual.width || expected.height !== actual.height) {
    await writeOut(actualPath, png);
    return {
      status: 'mismatch',
      diffRatio: 1,
      actualPath,
      diffPath: null,
      reason: `size ${String(actual.width)}x${String(actual.height)} differs from baseline ${String(expected.width)}x${String(expected.height)}`,
    };
  }

  const diff = new PNG({ width: actual.width, height: actual.height });
  const differing = pixelmatch(expected.data, actual.data, diff.data, actual.width, actual.height, {
    threshold: PIXEL_THRESHOLD,
  });
  const diffRatio = differing / (actual.width * actual.height);
  if (diffRatio <= MAX_DIFF_RATIO) {
    return { status: 'match', diffRatio };
  }

  const diffPath = resolve(options.outDir, `${name}.diff.png`);
  await writeOut(actualPath, png);
  await writeOut(diffPath, PNG.sync.write(diff));
  return {
    status: 'mismatch',
    diffRatio,
    actualPath,
    diffPath,
    reason: `${(diffRatio * 100).toFixed(3)}% of pixels differ (limit ${String(MAX_DIFF_RATIO * 100)}%)`,
  };
}
