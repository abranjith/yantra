/**
 * Pure summaries for spike S1 (FEAT-069 TASK-001): frame timing, main-thread
 * share, JPEG sizes, analytic glass contrast and the report table.
 *
 * Vitest-free (memory: harness modules stay Vitest-free) and deterministic, so
 * `metrics.spec.ts` can pin every function without a browser.
 */

import {
  BLACK,
  DRSHYA_TOKENS,
  GLASS_SPEC,
  GLASS_TEXT_TOKENS,
  WHITE,
  compositeOver,
  contrastRatio,
  resolveGlassAlpha,
  resolveRgb,
  type Rgb,
  type Theme,
} from '@yantra/ui';

/** A metrics input the summaries cannot interpret. */
export class SpikeMetricsError extends Error {
  public override readonly name = 'SpikeMetricsError';
}

/**
 * Nearest-rank percentile (`p` in 0..100) of `values`; `null` for an empty
 * list. Nearest-rank never interpolates, so the result is always a sample.
 */
export function percentile(values: readonly number[], p: number): number | null {
  if (!Number.isFinite(p) || p < 0 || p > 100) {
    throw new SpikeMetricsError(`Percentile must be within 0..100, got ${String(p)}.`);
  }
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1] ?? null;
}

/** Successive differences of a timestamp series (ms); fewer than two stamps yields none. */
export function intervals(timestamps: readonly number[]): number[] {
  const out: number[] = [];
  for (let index = 1; index < timestamps.length; index += 1) {
    const previous = timestamps[index - 1];
    const current = timestamps[index];
    if (previous !== undefined && current !== undefined) out.push(current - previous);
  }
  return out;
}

/** One `Performance.getMetrics` sample: `TaskDuration` and `Timestamp`, both in seconds. */
export interface TaskSample {
  readonly taskDuration: number;
  readonly timestamp: number;
}

/**
 * The share of one core a target's main thread spent busy between two
 * samples: `ΔTaskDuration ÷ Δwall`.
 *
 * @throws SpikeMetricsError on zero or negative wall time, or on a counter
 *   that went backwards (a renderer restart resets it).
 */
export function mainThreadShare(before: TaskSample, after: TaskSample): number {
  const wall = after.timestamp - before.timestamp;
  if (!(wall > 0)) {
    throw new SpikeMetricsError('Main-thread share needs a positive wall time between samples.');
  }
  const busy = after.taskDuration - before.taskDuration;
  if (busy < 0) {
    throw new SpikeMetricsError('TaskDuration went backwards; the target restarted mid-sample.');
  }
  return busy / wall;
}

/** Mean and max of a size list; zeros for an empty one. */
export function byteStats(sizes: readonly number[]): { mean: number; max: number } {
  if (sizes.length === 0) return { mean: 0, max: 0 };
  const total = sizes.reduce((sum, size) => sum + size, 0);
  return { mean: total / sizes.length, max: Math.max(...sizes) };
}

/** Frames per second over a window of draw timestamps (ms). */
export function framesPerSecond(drawTimestamps: readonly number[]): number {
  if (drawTimestamps.length < 2) return 0;
  const first = drawTimestamps[0] ?? 0;
  const last = drawTimestamps[drawTimestamps.length - 1] ?? 0;
  const span = last - first;
  return span > 0 ? ((drawTimestamps.length - 1) * 1000) / span : 0;
}

/** Re-export so the harness and its tests share exactly one WCAG formula. */
export { contrastRatio };

/** The worst contrast of one glass text token over pure black and pure white. */
export interface GlassContrastRow {
  readonly theme: Theme;
  readonly token: string;
  readonly alpha: number;
  readonly overBlack: number;
  readonly overWhite: number;
}

/**
 * Analytic contrast of every glass text token at the shipped tint opacity
 * over the two backdrop extremes (FEAT-061 formula, no pixel sampling).
 * Noise is excluded here; the token suite already proves the floor with it.
 */
export function glassContrastTable(
  themes: readonly Theme[] = ['light', 'dark'],
): GlassContrastRow[] {
  return themes.flatMap((theme) => {
    const tint = resolveRgb(DRSHYA_TOKENS, 'glass-tint', theme);
    const alpha = resolveGlassAlpha(DRSHYA_TOKENS, theme);
    return GLASS_TEXT_TOKENS.map((token) => {
      const text = resolveRgb(DRSHYA_TOKENS, token, theme);
      return {
        theme,
        token,
        alpha,
        overBlack: contrastRatio(text, compositeOver(tint, alpha, BLACK)),
        overWhite: contrastRatio(text, compositeOver(tint, alpha, WHITE)),
      };
    });
  });
}

/** The CSS values the viewer's glass panels use, derived from the same tokens. */
export interface ViewerGlass {
  readonly tint: Rgb;
  readonly text: Rgb;
  readonly alpha: number;
  readonly blurPx: number;
  readonly saturate: number;
}

export function viewerGlass(theme: Theme): ViewerGlass {
  return {
    tint: resolveRgb(DRSHYA_TOKENS, 'glass-tint', theme),
    text: resolveRgb(DRSHYA_TOKENS, 'ink', theme),
    alpha: resolveGlassAlpha(DRSHYA_TOKENS, theme),
    blurPx: GLASS_SPEC.blurPx,
    saturate: GLASS_SPEC.saturate,
  };
}

/** One measured combination. */
export interface SpikeResultRow {
  readonly surfaces: 'glass' | 'solid';
  readonly targetFps: number;
  readonly quality: number;
  readonly maxWidth: number;
  readonly maxHeight: number;
  readonly drawnFps: number;
  readonly intervalP50: number | null;
  readonly intervalP95: number | null;
  readonly viewerShare: number;
  readonly sourceShare: number;
  readonly meanBytes: number;
  readonly maxBytes: number;
  readonly framesDrawn: number;
  readonly framesReplaced: number;
}

const fixed = (value: number | null, digits: number): string =>
  value === null ? '—' : value.toFixed(digits);
const percent = (share: number): string => `${(share * 100).toFixed(1)} %`;
const kib = (bytes: number): string => `${(bytes / 1024).toFixed(1)}`;

/** Renders the result table as stable markdown (fixed column order and number formats). */
export function renderResultTable(rows: readonly SpikeResultRow[]): string {
  const header =
    '| Surfaces | Target fps | Quality | Max size | Drawn fps | Interval p50 (ms) | Interval p95 (ms) | Viewer main thread | Source main thread | Mean KiB | Max KiB | Drawn | Replaced |';
  const rule =
    '| -------- | ---------- | ------- | -------- | --------- | ----------------- | ----------------- | ------------------ | ------------------ | -------- | ------- | ----- | -------- |';
  const body = rows.map(
    (row) =>
      `| ${row.surfaces} | ${row.targetFps} | ${row.quality} | ${row.maxWidth}×${row.maxHeight} | ${fixed(row.drawnFps, 1)} | ${fixed(row.intervalP50, 0)} | ${fixed(row.intervalP95, 0)} | ${percent(row.viewerShare)} | ${percent(row.sourceShare)} | ${kib(row.meanBytes)} | ${kib(row.maxBytes)} | ${row.framesDrawn} | ${row.framesReplaced} |`,
  );
  return [header, rule, ...body].join('\n');
}

/** Renders the analytic contrast table as stable markdown. */
export function renderContrastTable(rows: readonly GlassContrastRow[]): string {
  const header = '| Theme | Token | Tint alpha | Over black | Over white |';
  const rule = '| ----- | ----- | ---------- | ---------- | ---------- |';
  const body = rows.map(
    (row) =>
      `| ${row.theme} | ${row.token} | ${row.alpha.toFixed(3)} | ${row.overBlack.toFixed(2)}:1 | ${row.overWhite.toFixed(2)}:1 |`,
  );
  return [header, rule, ...body].join('\n');
}
