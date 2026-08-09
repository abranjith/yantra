import { isOpen, resolveContainer, type WidgetContainer } from '../widgets/open-state.js';
import { clickCandidate, collectCandidates, rankCandidate } from '../widgets/option/candidates.js';
import type { WidgetBudget, WidgetPort, WidgetTarget } from '../widgets/types.js';
import { readCommitted } from '../widgets/verify.js';

import { fillFailure, type FillFailure } from './types.js';

/** Maximum time spent waiting for a popup that typing may reveal. */
export const REACTION_WAIT_MS = 1_500;
/** Polling cadence for post-type popup discovery. */
export const REACTION_POLL_MS = 150;

/** Successful post-type reaction. */
export interface ReactionSuccess {
  readonly ok: true;
  readonly committed: string;
  readonly selected: boolean;
  readonly dismissed: boolean;
  readonly actions: number;
}

/** Result of watching for and, when safe, committing a suggestion. */
export type ReactionOutcome = ReactionSuccess | FillFailure;

/**
 * Watch for a popup that appears only after typing and select its unique best
 * candidate. No pre-detection signal is required; unmatched candidates are
 * dismissed while the typed literal remains committed.
 *
 * This runs only for controls that accept typed text, so the characters are
 * already a valid commit and a suggestion list that cannot be resolved is
 * released rather than treated as an error. Picking one of several
 * equally-ranked suggestions would be the guess this engine refuses to make,
 * but failing the fill would discard work the caller never asked to undo — and
 * an editable combobox is a search box, not a menu. A control that genuinely
 * requires a choice never reaches here: it is driven by the listbox driver,
 * which still reports `WIDGET_AMBIGUOUS_CHOICE` rather than guessing.
 */
export async function watchAndSelect(
  port: WidgetPort,
  target: WidgetTarget,
  typedText: string,
  budget: WidgetBudget,
  ignoredContainer?: WidgetContainer | null,
): Promise<ReactionOutcome> {
  const deadline = Math.min(budget.deadlineMs, port.now() + REACTION_WAIT_MS);
  do {
    const container = await resolveContainer(port, target, { allowUnlinked: true });
    if (container && sameContainer(container, ignoredContainer)) {
      return {
        ok: true,
        committed: await readCommitted(port, target),
        selected: false,
        dismissed: false,
        actions: 0,
      };
    }
    if (container && (await isOpen(port, target, container))) {
      const candidates = await collectCandidates(port, container);
      if (candidates.length > 0) {
        const ranked = rankCandidate(candidates, typedText);
        if (ranked.kind === 'none' || ranked.kind === 'ambiguous') {
          await port.press('Escape');
          await sleep(REACTION_POLL_MS);
          const committed = await readCommitted(port, target);
          return {
            ok: true,
            committed,
            selected: false,
            dismissed: !(await isOpen(port, target, container)),
            actions: 0,
          };
        }
        if (budget.maxActions < 2 || port.now() > budget.deadlineMs) {
          return fillFailure(
            'WIDGET_TARGET_UNREACHABLE',
            'The fill action budget was exhausted before the suggestion could be selected.',
            { reason: 'budget', offered: ranked.candidate.name },
          );
        }
        await clickCandidate(port, ranked.candidate);
        const committed = await readCommitted(port, target);
        if (committed.trim().length === 0) {
          return fillFailure(
            'WIDGET_NOT_COMMITTED',
            `The suggestion was clicked, but "${target.name}" has no committed value.`,
            { committed },
          );
        }
        const stillOpen = await isOpen(port, target, container);
        return {
          ok: true,
          committed,
          selected: true,
          dismissed: !stillOpen,
          actions: 1,
        };
      }
    }
    if (port.now() >= deadline) break;
    await sleep(REACTION_POLL_MS);
  } while (port.now() <= deadline);

  return {
    ok: true,
    committed: await readCommitted(port, target),
    selected: false,
    dismissed: false,
    actions: 0,
  };
}

function sameContainer(left: WidgetContainer, right: WidgetContainer | null | undefined): boolean {
  return left.path.join('.') === right?.path.join('.');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
