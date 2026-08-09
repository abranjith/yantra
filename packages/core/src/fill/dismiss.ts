import {
  isOpen,
  openIfClosed,
  resolveContainer,
  type WidgetContainer,
} from '../widgets/open-state.js';
import {
  clickCandidate,
  collectCandidates,
  type WidgetCandidate,
} from '../widgets/option/candidates.js';
import type { WidgetPort, WidgetTarget } from '../widgets/types.js';
import { readCommitted } from '../widgets/verify.js';

import { fillFailure, type FillFailure } from './types.js';

const COMMIT_CONTROL_RE = /^(done|apply|ok|save|close)$/i;
const DISMISS_SETTLE_MS = 150;

/** Successful commit-and-release pass. */
export interface DismissSuccess {
  readonly ok: true;
  readonly dismissed: boolean;
  readonly committed: string;
  readonly actions: number;
}

/** Result of closing a field's floating container without losing its value. */
export type DismissOutcome = DismissSuccess | FillFailure;

/**
 * Close any floating container associated with a field and verify both that the
 * overlay is gone and that a value the widget had already committed survived.
 *
 * Value preservation is only enforced when `committedBefore` already satisfied
 * the intent. A widget that commits on release, or one that spreads a range
 * across a pair of controls, legitimately still reads its old value here — that
 * is what the release is for — so judging it against the intent would report a
 * selection that is about to land as lost. The caller performs the
 * authoritative verification on the settled page.
 */
export async function dismissWidget(
  port: WidgetPort,
  target: WidgetTarget,
  committedBefore: string,
  matches: (committed: string) => boolean,
  ignoredContainer?: WidgetContainer | null,
): Promise<DismissOutcome> {
  const container = await resolveContainer(port, target, { allowUnlinked: true });
  if (container && container.path.join('.') === ignoredContainer?.path.join('.')) {
    return { ok: true, dismissed: false, committed: committedBefore, actions: 0 };
  }
  if (!container || !(await isOpen(port, target, container))) {
    return { ok: true, dismissed: false, committed: committedBefore, actions: 0 };
  }

  const preserved = matches(committedBefore);
  const control = await uniqueCommitControl(port, container);
  let usedEscape = false;
  let actions = 0;
  if (control) {
    await clickCandidate(port, control);
    actions += 1;
  } else {
    usedEscape = true;
    await port.press('Escape');
  }
  await sleep(DISMISS_SETTLE_MS);

  let committed = await readCommitted(port, target);
  let stillOpen = await isOpen(port, target, container);
  if (usedEscape && preserved && !matches(committed)) {
    const reopened = await openIfClosed(port, target);
    if (reopened.ok) {
      if (!reopened.wasOpen) actions += 1;
      const retryControl = await uniqueCommitControl(port, reopened.container);
      if (retryControl) {
        await clickCandidate(port, retryControl);
        actions += 1;
        await sleep(DISMISS_SETTLE_MS);
        committed = await readCommitted(port, target);
        stillOpen = await isOpen(port, target, reopened.container);
      }
    }
  }

  if (stillOpen || (preserved && !matches(committed))) {
    return fillFailure(
      'WIDGET_DISMISS_FAILED',
      `The value was committed, but the floating widget for "${target.name}" could not be released without losing it.`,
      {
        stillOpen: stillOpen ? target.name : null,
        committed,
      },
    );
  }
  return { ok: true, dismissed: true, committed, actions };
}

async function uniqueCommitControl(
  port: WidgetPort,
  container: WidgetContainer,
): Promise<WidgetCandidate | null> {
  const matches = (await collectCandidates(port, container)).filter(
    (candidate) => !candidate.disabled && COMMIT_CONTROL_RE.test(candidate.name.trim()),
  );
  return matches.length === 1 ? matches[0]! : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
