import { observedDetails, type CommittedValue } from '../interaction/protected-value.js';
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
import { readCommittedValue } from '../widgets/verify.js';

import { fillFailure, type FillFailure } from './types.js';

const COMMIT_CONTROL_RE = /^(done|apply|ok|save|close)$/i;
const DISMISS_SETTLE_MS = 150;

/** Successful commit-and-release pass. */
export interface DismissSuccess {
  readonly ok: true;
  readonly dismissed: boolean;
  readonly committed: CommittedValue;
  readonly actions: number;
}

/** Result of closing a field's floating container without losing its value. */
export type DismissOutcome = DismissSuccess | FillFailure;

/** Which container this pass may close, and which it must leave alone. */
export interface DismissScope {
  /**
   * A container that was already open before the fill began and is therefore
   * not the fill's to close — typically a modal the field merely lives inside.
   */
  readonly ignoredContainer?: WidgetContainer | null;
  /**
   * The container a widget driver actually operated.
   *
   * This outranks `ignoredContainer`. A picker the driver drove is the fill's
   * business whether or not it was already open when the fill arrived, and
   * "leave open what I found open" quietly turned a range that only lands on
   * release into a reported success the page had not accepted.
   */
  readonly driven?: WidgetContainer | null;
  /**
   * The text the control should hold after release.
   *
   * Passed to every read so a protected control is judged inside the page; a
   * withheld read with no expected text has no verdict and can never match.
   */
  readonly expected?: string;
}

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
  committedBefore: CommittedValue,
  matches: (committed: CommittedValue) => boolean,
  scope: DismissScope = {},
): Promise<DismissOutcome> {
  const container = scope.driven ?? (await resolveContainer(port, target, { allowUnlinked: true }));
  if (
    !scope.driven &&
    container &&
    container.path.join('.') === scope.ignoredContainer?.path.join('.')
  ) {
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

  const read = (): Promise<CommittedValue> =>
    readCommittedValue(
      port,
      target,
      scope.expected === undefined ? {} : { expected: scope.expected },
    );
  let committed = await read();
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
        committed = await read();
        stillOpen = await isOpen(port, target, reopened.container);
      } else {
        // Reopening was a probe for a commit control this widget turns out not
        // to have. Escape has already put the value back the way it was, so
        // there is nothing here to save — and leaving the picker standing open
        // hands the caller a page with an overlay across it for no gain.
        await port.press('Escape');
        await sleep(DISMISS_SETTLE_MS);
        stillOpen = await isOpen(port, target, reopened.container);
      }
    }
  }

  const disclosedCommitted = committed.kind === 'disclosed' ? { committed: committed.text } : {};
  if (stillOpen) {
    return fillFailure(
      'WIDGET_DISMISS_FAILED',
      'overlay-still-open',
      `The value was committed, but the floating widget for "${target.name}" could not be released without losing it.`,
      {
        stillOpen: target.name,
        ...disclosedCommitted,
        ...(committed.kind === 'withheld' ? observedDetails(committed) : {}),
      },
    );
  }
  if (preserved && !matches(committed)) {
    // The overlay is gone and so is the value it was showing: a verified loss
    // on release, not an overlay problem. Reported as "the overlay is still
    // open, the value is set", the old wording described neither fact.
    return fillFailure(
      'WIDGET_NOT_COMMITTED',
      'value-rejected-on-release',
      `The "${target.name}" control held the value while its widget was open and lost it when the widget closed.`,
      { released: true, ...disclosedCommitted, ...observedDetails(committed) },
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
