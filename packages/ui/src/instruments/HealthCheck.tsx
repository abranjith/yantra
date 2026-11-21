import type { DoctorStatus } from '@yantra/protocol';
import type { ReactNode } from 'react';

import { Icon } from '../icons/Icon.js';
import type { IconName } from '../icons/registry.js';
import { cn, tv } from '../lib/cn.js';
import { Disclosure, DisclosurePanel, DisclosureTrigger } from '../primitives/Disclosure.js';

/**
 * HealthCheck (FEAT-071 TASK-006): renders one `yantra doctor` check row.
 *
 * - Status icon from the semantic registry paired with the CLI word (`ok`, `warn`, `fail`).
 * - Title and summary.
 * - Optional Disclosure for structured key/value details (values in mono).
 * - Optional prose remediation and remediation action slot.
 */

export interface HealthCheckProps {
  readonly id: string;
  readonly title: string;
  readonly status: DoctorStatus;
  readonly summary: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly remediation?: string;
  readonly remediationSlot?: ReactNode;
  readonly className?: string;
}

const STATUS_ICON: Readonly<Record<DoctorStatus, IconName>> = {
  ok: 'outcome.fulfilled',
  warn: 'outcome.partial',
  fail: 'outcome.failed',
};

const statusBadgeStyles = tv({
  base: 'inline-flex shrink-0 items-center gap-1.5 rounded-badge border px-2 py-0.5 text-micro font-medium',
  variants: {
    status: {
      ok: 'border-signal-fulfilled-border bg-signal-fulfilled-bg text-signal-fulfilled-ink',
      warn: 'border-signal-caution-border bg-signal-caution-bg text-signal-caution-ink',
      fail: 'border-signal-failed-border bg-signal-failed-bg text-signal-failed-ink',
    },
  },
});

function formatDetailValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null || value === undefined) return 'null';
  return JSON.stringify(value);
}

export function HealthCheck({
  id,
  title,
  status,
  summary,
  details,
  remediation,
  remediationSlot,
  className,
}: HealthCheckProps): ReactNode {
  const detailEntries = details === undefined ? [] : Object.entries(details);

  return (
    <article
      data-check-id={id}
      data-check-status={status}
      className={cn(
        'flex flex-col gap-2 rounded-card border border-rule bg-surface p-4 text-caption',
        className,
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={statusBadgeStyles({ status })}>
              <Icon name={STATUS_ICON[status]} size={16} label={status} />
              <span>{status}</span>
            </span>
            <h3 className="font-medium text-ink">{title}</h3>
          </div>
          <p className="text-ink-2">{summary}</p>
        </div>
        {remediationSlot !== undefined ? <div className="shrink-0">{remediationSlot}</div> : null}
      </div>

      {remediation !== undefined ? <p className="text-micro text-ink-2">{remediation}</p> : null}

      {detailEntries.length > 0 ? (
        <Disclosure className="mt-1">
          <DisclosureTrigger className="text-micro">Details</DisclosureTrigger>
          <DisclosurePanel>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-micro">
              {detailEntries.map(([key, value]) => (
                <div key={key} className="contents">
                  <dt className="text-ink-2">{key}</dt>
                  <dd className="type-engine break-all text-ink">{formatDetailValue(value)}</dd>
                </div>
              ))}
            </dl>
          </DisclosurePanel>
        </Disclosure>
      ) : null}
    </article>
  );
}
