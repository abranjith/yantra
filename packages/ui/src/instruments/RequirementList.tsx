import type { BriefRequirement } from '@yantra/protocol';
import type { ReactNode } from 'react';

import { Icon } from '../icons/Icon.js';
import type { IconName } from '../icons/registry.js';
import { cn } from '../lib/cn.js';

import { outcomeBadgeStyles } from './OutcomeBadge.js';

/**
 * RequirementList (FEAT-066): a `do` Brief's declared requirements, each
 * with its status word verbatim from the protocol (`met | unmet |
 * not_applicable`), paired with an icon and text, never color alone.
 * {@link StatusWord} is shared with ConditionTable.
 */

type Tone = 'fulfilled' | 'failed' | 'neutral';

const STATUS_TONE: Readonly<Record<string, Tone>> = {
  met: 'fulfilled',
  verified: 'fulfilled',
  unmet: 'failed',
  violated: 'failed',
  not_applicable: 'neutral',
  unverified: 'neutral',
};

const TONE_ICON: Readonly<Record<Tone, IconName>> = {
  fulfilled: 'outcome.fulfilled',
  failed: 'outcome.failed',
  neutral: 'status.info',
};

/** A protocol status word as a badge: the word verbatim, an icon and a tone. */
export function StatusWord({ word }: { readonly word: string }): ReactNode {
  const tone = STATUS_TONE[word] ?? 'neutral';
  return (
    <span data-part="status" data-status={word} className={outcomeBadgeStyles({ tone })}>
      <Icon name={TONE_ICON[tone]} size={16} />
      <span>{word}</span>
    </span>
  );
}

export interface RequirementListProps {
  readonly requirements: readonly BriefRequirement[];
  readonly className?: string;
}

/** A `do` Brief's requirements; see the module comment. */
export function RequirementList({ requirements, className }: RequirementListProps): ReactNode {
  if (requirements.length === 0) return null;
  return (
    <ul className={cn('flex flex-col gap-3', className)} aria-label="Requirements">
      {requirements.map((requirement) => (
        <li key={requirement.id} data-requirement={requirement.id} className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <StatusWord word={requirement.status} />
            <span className="font-semibold text-ink">{requirement.label}</span>
          </div>
          {requirement.reason === null ? null : <p className="text-ink-2">{requirement.reason}</p>}
          {requirement.exemptions === undefined || requirement.exemptions.length === 0 ? null : (
            <div className="flex flex-col gap-1">
              <span className="type-label text-ink-2">Left out of the fill</span>
              <ul className="flex flex-wrap gap-2">
                {requirement.exemptions.map((exemption, index) => (
                  <li
                    key={`${exemption.label}-${String(index)}`}
                    className="rounded-chip border border-rule px-2 py-0.5 text-caption text-ink-2"
                  >
                    {exemption.label}: {exemption.reason}
                  </li>
                ))}
                {requirement.exempt_overflow === undefined ? null : (
                  <li className="px-2 py-0.5 text-caption text-ink-2">
                    +{requirement.exempt_overflow} more
                  </li>
                )}
              </ul>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
