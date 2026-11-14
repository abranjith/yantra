import type { ReactNode } from 'react';

import { Icon } from '../icons/Icon.js';
import type { IconName } from '../icons/registry.js';
import { cn } from '../lib/cn.js';
import { Button } from '../primitives/Button.js';

/**
 * RunStatusBanner (FEAT-067): a run's displayed state (plan §8) as a word,
 * one line of detail, and the actions that apply.
 *
 * - The word is the CLI's, paired with an icon and a tone, never color alone.
 * - Actions are plain buttons in order; the first `primary` one is the place
 *   to act. The caller decides what each does (an RPC, a route, a confirm).
 * - The banner is not a live region: the cockpit announces changes through
 *   its own polite region (TASK-006), so nothing is read twice.
 */

/** The banner's tone. */
export type StatusBannerTone = 'neutral' | 'attention' | 'caution' | 'fulfilled' | 'failed';

/** One action button. */
export interface StatusBannerAction {
  readonly id: string;
  readonly label: string;
  readonly onPress: () => void;
  readonly tone?: 'primary' | 'secondary' | 'danger';
  readonly isDisabled?: boolean;
}

const TONE_ICON: Readonly<Record<StatusBannerTone, IconName>> = {
  neutral: 'glyph.bindu',
  attention: 'status.needsYou',
  caution: 'status.info',
  fulfilled: 'outcome.fulfilled',
  failed: 'outcome.failed',
};

const TONE_TEXT: Readonly<Record<StatusBannerTone, string>> = {
  neutral: 'text-ink',
  attention: 'text-signal-needs-you-ink',
  caution: 'text-signal-partial-ink',
  fulfilled: 'text-signal-fulfilled-ink',
  failed: 'text-signal-failed-ink',
};

const TONE_EDGE: Readonly<Record<StatusBannerTone, string>> = {
  neutral: 'border-l-rule-strong',
  attention: 'border-l-signal-needs-you',
  caution: 'border-l-signal-partial',
  fulfilled: 'border-l-signal-fulfilled',
  failed: 'border-l-signal-failed',
};

export interface RunStatusBannerProps {
  /** The state word, verbatim (e.g. `waiting for you`). */
  readonly word: string;
  readonly detail: string;
  readonly tone?: StatusBannerTone;
  readonly actions?: readonly StatusBannerAction[];
  /** Extra content under the actions (e.g. a CLI twin to copy). */
  readonly children?: ReactNode;
  readonly className?: string;
}

/** See the module comment. */
export function RunStatusBanner({
  word,
  detail,
  tone = 'neutral',
  actions = [],
  children,
  className,
}: RunStatusBannerProps): ReactNode {
  return (
    <section
      aria-label={`Run status: ${word}`}
      data-instrument="status"
      data-tone={tone}
      className={cn(
        'flex flex-col gap-2 rounded-control border border-l-4 border-rule bg-surface p-3',
        TONE_EDGE[tone],
        className,
      )}
    >
      <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span
          className={cn('inline-flex items-center gap-1 font-semibold', TONE_TEXT[tone])}
          data-part="word"
        >
          <Icon name={TONE_ICON[tone]} size={16} />
          {word}
        </span>
        <span className="text-ink-2" data-part="detail">
          {detail}
        </span>
      </p>
      {actions.length === 0 ? null : (
        <div className="flex flex-wrap gap-2">
          {actions.map((action) => (
            <Button
              key={action.id}
              size="sm"
              variant={action.tone === 'primary' ? 'primary' : 'secondary'}
              onPress={action.onPress}
              {...(action.isDisabled === undefined ? {} : { isDisabled: action.isDisabled })}
              {...(action.tone === 'danger' ? { className: 'text-signal-failed-ink' } : {})}
            >
              {action.label}
            </Button>
          ))}
        </div>
      )}
      {children}
    </section>
  );
}
