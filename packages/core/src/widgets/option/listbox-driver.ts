import { openIfClosed, resolveContainer } from '../open-state.js';
import { widgetFailure, type WidgetDriver, type WidgetOutcome } from '../types.js';
import { matchesIntent, readCommitted } from '../verify.js';

import { clickCandidate, collectCandidates, rankCandidate } from './candidates.js';

/** Driver for listbox, menu, and homogeneous clickable-choice popups. */
export const listboxDriver: WidgetDriver = {
  kind: 'listbox',
  family: 'option',
  detect: async (port, target) => {
    const signal = await port.evaluateOn(target.ref, (element) => ({
      popup: element.getAttribute('aria-haspopup')?.toLowerCase() ?? '',
      controls: element.hasAttribute('aria-controls') || element.hasAttribute('aria-owns'),
    }));
    const container = await resolveContainer(port, target);
    if (container) {
      const shape = await port.evaluate((path) => {
        let current: Element | null = document.documentElement;
        for (const index of path) current = current?.children.item(index) ?? null;
        if (!current) return { role: '', choices: 0 };
        return {
          role: current.getAttribute('role')?.toLowerCase() ?? '',
          choices: current.querySelectorAll(
            '[role="option"],button,a[href],[role="menuitem"],li[onclick],li[tabindex]',
          ).length,
        };
      }, container.path);
      if (shape.role === 'listbox' || shape.role === 'menu') return 0.95;
      if (shape.choices >= 2) return 0.7;
    }
    if (signal.popup === 'listbox' || signal.popup === 'menu') return 0.8;
    return signal.controls ? 0.45 : 0;
  },
  drive: async (port, target, intent, budget): Promise<WidgetOutcome> => {
    if (intent.kind !== 'option') {
      return widgetFailure('WIDGET_TARGET_UNREACHABLE', 'A listbox accepts only option intents.');
    }
    const opened = await openIfClosed(port, target);
    if (!opened.ok) return opened;
    let actions = opened.wasOpen ? 0 : 1;
    if (port.now() > budget.deadlineMs || actions >= budget.maxActions) {
      return widgetFailure('WIDGET_TARGET_UNREACHABLE', 'The widget action budget was exhausted.', {
        reason: 'budget',
      });
    }
    const candidates = await collectCandidates(port, opened.container);
    const ranked = rankCandidate(candidates, intent.value);
    if (ranked.kind === 'ambiguous') {
      return widgetFailure(
        'WIDGET_AMBIGUOUS_CHOICE',
        `Several offered choices match "${intent.value}" at the same rank.`,
        { offered: ranked.offered },
      );
    }
    if (ranked.kind === 'none') {
      return widgetFailure(
        'WIDGET_TARGET_UNREACHABLE',
        `The widget does not offer a choice matching "${intent.value}".`,
        { offered: ranked.offered },
      );
    }
    await clickCandidate(port, ranked.candidate);
    actions += 1;
    const committed = await readCommitted(port, target);
    if (!matchesIntent(committed, intent)) {
      return widgetFailure(
        'WIDGET_NOT_COMMITTED',
        `The choice was clicked, but "${target.name}" did not commit it.`,
        { committed },
      );
    }
    return { ok: true, driver: 'listbox', committed, actions };
  },
};
