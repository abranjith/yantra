/**
 * Display formatting shared by the run pages (FEAT-066). Values the CLI prints
 * as words (status, outcome, mode) are never reformatted; only times, sizes
 * and money are.
 */

/** Shown for a value the run did not record. */
export const NOT_RECORDED = '—';

const TIMESTAMP = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** A start or end time, in the viewer's locale; the raw text when it does not parse. */
export function formatTimestamp(iso: string | null | undefined): string {
  if (iso === null || iso === undefined || iso.length === 0) return NOT_RECORDED;
  const time = Date.parse(iso);
  return Number.isNaN(time) ? iso : TIMESTAMP.format(new Date(time));
}

const TIME_OF_DAY = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' });
const DAY_AND_MONTH = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
const DAY_MONTH_YEAR = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * When something happened, the way a person says it: `Today, 9:42 PM`,
 * `Yesterday, 4:30 PM`, `Nov 20, 11:22 AM`, or with the year when it is not
 * this year. {@link formatTimestamp} gives the full value.
 */
export function formatWhen(iso: string | null | undefined, now: Date = new Date()): string {
  if (iso === null || iso === undefined || iso.length === 0) return NOT_RECORDED;
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return iso;
  const date = new Date(time);
  const clock = TIME_OF_DAY.format(date);
  if (sameDay(date, now)) return `Today, ${clock}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(date, yesterday)) return `Yesterday, ${clock}`;
  return date.getFullYear() === now.getFullYear()
    ? `${DAY_AND_MONTH.format(date)}, ${clock}`
    : DAY_MONTH_YEAR.format(date);
}

/** A duration: `850 ms`, `12.4 s`, `3 min 5 s`. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return NOT_RECORDED;
  if (ms < 1_000) return `${String(Math.round(ms))} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1_000);
  return seconds === 0 ? `${String(minutes)} min` : `${String(minutes)} min ${String(seconds)} s`;
}

/** A metered cost in USD. */
export function formatCost(usd: number | null | undefined): string {
  if (usd === null || usd === undefined || !Number.isFinite(usd)) return NOT_RECORDED;
  if (usd > 0 && usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

/** A byte count: `512 B`, `1.5 KiB`, `3.0 MiB`. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return NOT_RECORDED;
  if (bytes < 1_024) return `${String(bytes)} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KiB`;
  if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(1)} MiB`;
  return `${(bytes / 1_073_741_824).toFixed(1)} GiB`;
}
