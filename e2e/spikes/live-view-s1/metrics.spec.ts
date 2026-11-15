/**
 * Unit tests for spike S1's pure summaries (FEAT-069 TASK-001).
 */

import {
  BLACK,
  WHITE,
  compositeOver,
  DRSHYA_TOKENS,
  resolveGlassAlpha,
  resolveRgb,
} from '@yantra/ui';
import { describe, expect, it } from 'vitest';

import {
  SpikeMetricsError,
  byteStats,
  contrastRatio,
  framesPerSecond,
  glassContrastTable,
  intervals,
  mainThreadShare,
  percentile,
  renderContrastTable,
  renderResultTable,
  viewerGlass,
  type SpikeResultRow,
} from './metrics.js';

describe('percentile', () => {
  it('returns null for an empty list', () => {
    expect(percentile([], 50)).toBeNull();
  });

  it('returns the only sample for a single-element list at any percentile', () => {
    expect(percentile([42], 0)).toBe(42);
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 100)).toBe(42);
  });

  it('uses nearest rank for an odd count', () => {
    const values = [5, 1, 4, 2, 3];
    expect(percentile(values, 50)).toBe(3);
    expect(percentile(values, 95)).toBe(5);
    expect(percentile(values, 20)).toBe(1);
  });

  it('uses nearest rank for an even count without interpolating', () => {
    const values = [10, 40, 20, 30];
    expect(percentile(values, 50)).toBe(20);
    expect(percentile(values, 75)).toBe(30);
    expect(percentile(values, 100)).toBe(40);
  });

  it('does not reorder the caller array', () => {
    const values = [3, 1, 2];
    percentile(values, 50);
    expect(values).toEqual([3, 1, 2]);
  });

  it.each([-1, 101, Number.NaN])('rejects percentile %s', (p) => {
    expect(() => percentile([1], p)).toThrow(SpikeMetricsError);
  });
});

describe('intervals', () => {
  it('yields nothing for fewer than two timestamps', () => {
    expect(intervals([])).toEqual([]);
    expect(intervals([7])).toEqual([]);
  });

  it('yields successive differences', () => {
    expect(intervals([0, 100, 250, 260])).toEqual([100, 150, 10]);
  });
});

describe('mainThreadShare', () => {
  it('is busy time over wall time', () => {
    expect(
      mainThreadShare({ taskDuration: 1, timestamp: 100 }, { taskDuration: 1.5, timestamp: 110 }),
    ).toBeCloseTo(0.05);
  });

  it('is zero when the thread was idle', () => {
    expect(
      mainThreadShare({ taskDuration: 2, timestamp: 0 }, { taskDuration: 2, timestamp: 30 }),
    ).toBe(0);
  });

  it('rejects zero wall time', () => {
    expect(() =>
      mainThreadShare({ taskDuration: 1, timestamp: 5 }, { taskDuration: 2, timestamp: 5 }),
    ).toThrow(/positive wall time/);
  });

  it('rejects negative wall time', () => {
    expect(() =>
      mainThreadShare({ taskDuration: 1, timestamp: 6 }, { taskDuration: 2, timestamp: 5 }),
    ).toThrow(SpikeMetricsError);
  });

  it('rejects a counter reset', () => {
    expect(() =>
      mainThreadShare({ taskDuration: 9, timestamp: 0 }, { taskDuration: 1, timestamp: 30 }),
    ).toThrow(/went backwards/);
  });
});

describe('byteStats', () => {
  it('is zero for no frames', () => {
    expect(byteStats([])).toEqual({ mean: 0, max: 0 });
  });

  it('computes mean and max', () => {
    expect(byteStats([100, 300, 200])).toEqual({ mean: 200, max: 300 });
  });
});

describe('framesPerSecond', () => {
  it('is zero for fewer than two draws or zero span', () => {
    expect(framesPerSecond([])).toBe(0);
    expect(framesPerSecond([5])).toBe(0);
    expect(framesPerSecond([5, 5])).toBe(0);
  });

  it('counts intervals over the span', () => {
    expect(framesPerSecond([0, 200, 400, 600, 800, 1000])).toBe(5);
  });
});

describe('contrastRatio', () => {
  it('is 21 for black on white and order-independent', () => {
    expect(contrastRatio(BLACK, WHITE)).toBeCloseTo(21, 6);
    expect(contrastRatio(WHITE, BLACK)).toBeCloseTo(21, 6);
  });

  it('is 1 for equal colors', () => {
    expect(contrastRatio([0.3, 0.5, 0.7], [0.3, 0.5, 0.7])).toBe(1);
  });
});

describe('glassContrastTable', () => {
  const rows = glassContrastTable();

  it('covers both themes and both glass text tokens', () => {
    expect(rows.map((row) => `${row.theme}/${row.token}`)).toEqual([
      'light/ink',
      'light/ink-2',
      'dark/ink',
      'dark/ink-2',
    ]);
  });

  it('keeps every glass text token at or above 4.5:1 over both extremes at the scrim floor', () => {
    for (const row of rows) {
      expect(row.overBlack).toBeGreaterThanOrEqual(4.5);
      expect(row.overWhite).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('computes the tint-over-extreme composite with the shipped alpha', () => {
    const tint = resolveRgb(DRSHYA_TOKENS, 'glass-tint', 'light');
    const ink = resolveRgb(DRSHYA_TOKENS, 'ink', 'light');
    const alpha = resolveGlassAlpha(DRSHYA_TOKENS, 'light');
    const light = rows.find((row) => row.theme === 'light' && row.token === 'ink');
    expect(light?.alpha).toBe(alpha);
    expect(light?.overBlack).toBeCloseTo(contrastRatio(ink, compositeOver(tint, alpha, BLACK)), 9);
    expect(light?.overWhite).toBeCloseTo(contrastRatio(ink, compositeOver(tint, alpha, WHITE)), 9);
  });

  it('selects one theme when asked', () => {
    expect(glassContrastTable(['dark']).every((row) => row.theme === 'dark')).toBe(true);
  });
});

describe('viewerGlass', () => {
  it('derives the panel CSS values from the tokens', () => {
    const glass = viewerGlass('dark');
    expect(glass.alpha).toBe(resolveGlassAlpha(DRSHYA_TOKENS, 'dark'));
    expect(glass.tint).toEqual(resolveRgb(DRSHYA_TOKENS, 'glass-tint', 'dark'));
    expect(glass.blurPx).toBeGreaterThan(0);
  });
});

describe('report renderers', () => {
  const row: SpikeResultRow = {
    surfaces: 'glass',
    targetFps: 5,
    quality: 70,
    maxWidth: 1280,
    maxHeight: 800,
    drawnFps: 4.98,
    intervalP50: 200.4,
    intervalP95: 215.6,
    viewerShare: 0.0291,
    sourceShare: 0.06,
    meanBytes: 253_952,
    maxBytes: 256_000,
    framesDrawn: 150,
    framesReplaced: 0,
  };

  it('renders the result table stably', () => {
    expect(renderResultTable([row])).toMatchInlineSnapshot(`
      "| Surfaces | Target fps | Quality | Max size | Drawn fps | Interval p50 (ms) | Interval p95 (ms) | Viewer main thread | Source main thread | Mean KiB | Max KiB | Drawn | Replaced |
      | -------- | ---------- | ------- | -------- | --------- | ----------------- | ----------------- | ------------------ | ------------------ | -------- | ------- | ----- | -------- |
      | glass | 5 | 70 | 1280×800 | 5.0 | 200 | 216 | 2.9 % | 6.0 % | 248.0 | 250.0 | 150 | 0 |"
    `);
  });

  it('renders a dash for a missing percentile', () => {
    expect(renderResultTable([{ ...row, intervalP50: null, intervalP95: null }])).toContain(
      '| 5.0 | — | — |',
    );
  });

  it('renders only the header for no rows', () => {
    expect(renderResultTable([]).split('\n')).toHaveLength(2);
  });

  it('renders the contrast table stably', () => {
    expect(
      renderContrastTable([
        { theme: 'light', token: 'ink', alpha: 0.775, overBlack: 11.0512, overWhite: 19.009 },
      ]),
    ).toMatchInlineSnapshot(`
      "| Theme | Token | Tint alpha | Over black | Over white |
      | ----- | ----- | ---------- | ---------- | ---------- |
      | light | ink | 0.775 | 11.05:1 | 19.01:1 |"
    `);
  });
});
