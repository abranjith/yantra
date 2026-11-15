import type { CSSProperties, ReactNode } from 'react';

import { Icon } from '../icons/Icon.js';
import { cn } from '../lib/cn.js';

/**
 * BudgetGauge (FEAT-067): one budget a run spends against, as `used / limit`
 * text and a meter.
 *
 * - Only the dimensions a `budget_snapshot` carries are shown; there is no
 *   gauge for a budget the run does not have.
 * - A budget at or over its limit says `exhausted` in words, with an icon.
 * - An unbounded budget (no limit) shows what was used, with no meter.
 * - The meter is `role="meter"` with `aria-valuenow`/`aria-valuemax` and a
 *   text value, so the reading never depends on the bar.
 */

/** The unit of one budget dimension (protocol `budget_snapshot`). */
export type BudgetUnit = 'ms' | 'count' | 'bytes' | 'pixels';

/** One budget dimension as the protocol reports it. */
export interface BudgetGaugeValue {
  readonly name: string;
  readonly used: number;
  readonly limit: number | null;
  readonly unit: BudgetUnit;
}

/** A dimension name in words: the protocol name with its underscores as spaces. */
export function budgetName(name: string): string {
  return name.replace(/_/gu, ' ');
}

function duration(ms: number): string {
  if (ms < 1_000) return `${String(Math.round(ms))} ms`;
  const seconds = Math.floor(ms / 1_000);
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60)
    return rest === 0 ? `${String(minutes)}m` : `${String(minutes)}m ${String(rest)}s`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes === 0 ? `${String(hours)}h` : `${String(hours)}h ${String(restMinutes)}m`;
}

function bytes(value: number): string {
  if (value < 1_024) return `${String(value)} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KiB`;
  return `${(value / 1_048_576).toFixed(1)} MiB`;
}

/** An amount in its unit, as the gauge writes it. */
export function formatBudgetAmount(value: number, unit: BudgetUnit): string {
  switch (unit) {
    case 'ms':
      return duration(value);
    case 'bytes':
      return bytes(value);
    case 'pixels':
      return `${value.toLocaleString('en-US')} px`;
    case 'count':
      return value.toLocaleString('en-US');
  }
}

/** Whether a dimension has reached its limit. */
export function isExhausted(value: BudgetGaugeValue): boolean {
  return value.limit !== null && value.used >= value.limit;
}

export interface BudgetGaugeProps {
  readonly value: BudgetGaugeValue;
  readonly className?: string;
}

/** See the module comment. */
export function BudgetGauge({ value, className }: BudgetGaugeProps): ReactNode {
  const name = budgetName(value.name);
  const used = formatBudgetAmount(value.used, value.unit);
  const exhausted = isExhausted(value);
  if (value.limit === null) {
    return (
      <div data-budget={value.name} className={cn('flex min-w-28 flex-col gap-1', className)}>
        <span className="type-label text-ink-2">{name}</span>
        <span className="type-engine text-ink">{used} used</span>
      </div>
    );
  }
  const limit = formatBudgetAmount(value.limit, value.unit);
  const percent = value.limit === 0 ? 100 : Math.min(100, (value.used / value.limit) * 100);
  return (
    <div
      data-budget={value.name}
      data-exhausted={exhausted ? 'true' : undefined}
      className={cn('flex min-w-28 flex-col gap-1', className)}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="type-label text-ink-2">{name}</span>
        <span className={cn('type-engine', exhausted ? 'text-signal-failed-ink' : 'text-ink')}>
          {used} / {limit}
        </span>
      </div>
      <div
        role="meter"
        aria-label={name}
        aria-valuemin={0}
        aria-valuemax={value.limit}
        aria-valuenow={Math.min(value.used, value.limit)}
        aria-valuetext={`${used} of ${limit}${exhausted ? ', exhausted' : ''}`}
        style={{ '--budget-fill': `${percent.toFixed(1)}%` } as CSSProperties}
        className="h-1.5 overflow-hidden rounded-full bg-sunken"
      >
        <div
          className={cn('h-full w-(--budget-fill)', exhausted ? 'bg-signal-failed' : 'bg-accent')}
        />
      </div>
      {exhausted ? (
        <span className="inline-flex items-center gap-1 text-caption text-signal-failed-ink">
          <Icon name="outcome.failed" size={16} />
          exhausted
        </span>
      ) : null}
    </div>
  );
}

export interface BudgetGaugesProps {
  readonly dimensions: readonly BudgetGaugeValue[];
  readonly className?: string;
}

/** One gauge per dimension; nothing when there are none. */
export function BudgetGauges({ dimensions, className }: BudgetGaugesProps): ReactNode {
  if (dimensions.length === 0) return null;
  return (
    <ul aria-label="Budgets" className={cn('flex flex-wrap gap-4', className)}>
      {dimensions.map((value) => (
        <li key={value.name}>
          <BudgetGauge value={value} />
        </li>
      ))}
    </ul>
  );
}
