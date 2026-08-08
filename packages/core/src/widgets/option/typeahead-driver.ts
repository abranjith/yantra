import { isOpen, resolveContainer, restore } from '../open-state.js';
import { widgetFailure, type WidgetDriver, type WidgetOutcome } from '../types.js';
import { readCommitted } from '../verify.js';

import {
  clickCandidate,
  collectCandidates,
  normalizeCandidateText,
  rankCandidate,
} from './candidates.js';

/** Maximum wait for asynchronous typeahead suggestions. */
export const SUGGESTION_WAIT_MS = 3_000;
/** Poll cadence for asynchronous typeahead suggestions. */
export const SUGGESTION_POLL_MS = 150;

/** Driver for textbox/combobox controls that commit one offered suggestion. */
export const typeaheadDriver: WidgetDriver = {
  kind: 'typeahead',
  family: 'option',
  detect: async (port, target) =>
    port.evaluateOn(target.ref, (element) => {
      const role = element.getAttribute('role')?.toLowerCase() ?? '';
      const autocomplete = element.getAttribute('aria-autocomplete')?.toLowerCase() ?? '';
      const textInput =
        element instanceof HTMLInputElement &&
        !['date', 'checkbox', 'radio', 'button', 'submit'].includes(element.type.toLowerCase());
      if (autocomplete.length > 0) return 0.95;
      if (role === 'combobox' && textInput) return 0.9;
      if (
        textInput &&
        (element.hasAttribute('aria-controls') || element.hasAttribute('aria-owns'))
      ) {
        return 0.75;
      }
      return 0;
    }),
  drive: async (port, target, intent, budget): Promise<WidgetOutcome> => {
    if (intent.kind !== 'option') {
      return widgetFailure('WIDGET_TARGET_UNREACHABLE', 'A typeahead accepts only option intents.');
    }
    const initialContainer = await resolveContainer(port, target);
    const wasOpen = initialContainer ? await isOpen(port, target, initialContainer) : false;
    if (port.now() > budget.deadlineMs || budget.maxActions < 2) {
      return widgetFailure('WIDGET_TARGET_UNREACHABLE', 'The widget action budget was exhausted.', {
        reason: 'budget',
      });
    }
    await port.fill(target.ref, intent.value);
    let actions = 1;
    const waitDeadline = Math.min(budget.deadlineMs, port.now() + SUGGESTION_WAIT_MS);
    try {
      let offered: readonly string[] = [];
      while (port.now() <= waitDeadline) {
        const container = await resolveContainer(port, target);
        if (container && (await isOpen(port, target, container))) {
          const candidates = await collectCandidates(port, container);
          const ranked = rankCandidate(candidates, intent.value);
          offered = candidates.slice(0, 10).map((candidate) => candidate.name);
          if (ranked.kind === 'ambiguous') {
            return widgetFailure(
              'WIDGET_AMBIGUOUS_CHOICE',
              `Several suggestions match "${intent.value}" at the same rank.`,
              { offered: ranked.offered },
            );
          }
          if (ranked.kind === 'match') {
            await clickCandidate(port, ranked.candidate);
            actions += 1;
            const committed = await readCommitted(port, target);
            const committedText = normalizeCandidateText(committed);
            const candidateText = normalizeCandidateText(ranked.candidate.name);
            const rawText = normalizeCandidateText(intent.value);
            if (committedText === rawText) {
              return widgetFailure(
                'WIDGET_NOT_COMMITTED',
                `The suggestion was clicked, but "${target.name}" still contains the raw typed text.`,
                { committed },
              );
            }
            if (!committedText.includes(candidateText) && committedText.length === 0) {
              return widgetFailure(
                'WIDGET_NOT_COMMITTED',
                `The suggestion was clicked, but "${target.name}" has no committed value.`,
                { committed },
              );
            }
            return { ok: true, driver: 'typeahead', committed, actions };
          }
        }
        if (port.now() >= waitDeadline) {
          return widgetFailure(
            'WIDGET_TARGET_UNREACHABLE',
            `No matching suggestion appeared within ${SUGGESTION_WAIT_MS} ms.`,
            { waitMs: SUGGESTION_WAIT_MS, offered },
          );
        }
        await sleep(SUGGESTION_POLL_MS);
      }
      return widgetFailure(
        'WIDGET_TARGET_UNREACHABLE',
        `No matching suggestion appeared within ${SUGGESTION_WAIT_MS} ms.`,
        { waitMs: SUGGESTION_WAIT_MS },
      );
    } finally {
      await restore(port, target, wasOpen);
    }
  },
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
