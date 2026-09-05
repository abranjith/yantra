import {
  rankAgainstRequested,
  substitutionEvidence,
  type ChoiceSubstitution,
  type VerdictEvidence,
} from '../../interaction/index.js';
import { openIfClosed, resolveContainer } from '../open-state.js';
import { widgetFailure, type WidgetDriver, type WidgetOutcome } from '../types.js';
import { matchesCommitment, matchesIntent, readCommitted } from '../verify.js';

import { clickCandidate, collectChoices } from './candidates.js';
import { scanVirtualOptions } from './virtual-list.js';

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
  /**
   * What an opened container says about itself.
   *
   * Reached only from the engine's open probe. A declared listbox or menu is
   * conclusive; a homogeneous run of clickable choices is strong enough to act
   * on, since the driver verifies the commit against the option it clicked.
   */
  detectOpen: async (port, _target, container) =>
    port.evaluate((path) => {
      let current: Element | null = document.documentElement;
      for (const index of path) current = current?.children.item(index) ?? null;
      if (!(current instanceof HTMLElement)) return 0;
      const role = current.getAttribute('role')?.toLowerCase() ?? '';
      if (role === 'listbox' || role === 'menu') return 0.95;
      const choices = current.querySelectorAll(
        '[role="option"],button,a[href],[role="menuitem"],li[onclick],li[tabindex]',
      ).length;
      return choices >= 2 ? 0.7 : 0;
    }, container.path),
  drive: async (port, target, intent, budget): Promise<WidgetOutcome> => {
    if (intent.kind !== 'option') {
      return widgetFailure(
        'WIDGET_TARGET_UNREACHABLE',
        'intent-incompatible',
        'A listbox accepts only option intents.',
      );
    }
    const opened = await openIfClosed(port, target);
    if (!opened.ok) return opened;
    let actions = opened.wasOpen ? 0 : 1;
    if (port.now() > budget.deadlineMs || actions >= budget.maxActions) {
      return widgetFailure(
        'WIDGET_TARGET_UNREACHABLE',
        'budget',
        'The widget action budget was exhausted.',
        { reason: 'budget' },
      );
    }
    const choiceSet = await collectChoices(port, opened.container);
    const candidates = choiceSet.choices;
    const ranked = rankAgainstRequested(candidates, intent.value, opened.container.path);
    if (ranked.kind === 'ambiguous') {
      return widgetFailure(
        'WIDGET_AMBIGUOUS_CHOICE',
        'several-matched-equally',
        `Several offered choices match "${intent.value}" at the same rank.`,
        { offered: ranked.offered },
      );
    }

    // The structural entry condition. A list that already offers the value has
    // nothing to reveal, so it pays for no scroll at all — diagnostic work is
    // taken only on the path that needs it, and the zero here is asserted by
    // counting the operation rather than by inspection.
    let chosen = ranked.kind === 'match' ? ranked.candidate : null;
    let substitution: ChoiceSubstitution | undefined =
      ranked.kind === 'match' ? ranked.substitution : undefined;
    let offeredEvidence = ranked.kind === 'none' ? ranked.offered : [];
    let scannedOffered: readonly string[] | null = null;
    let scrollEvidence: VerdictEvidence | null = null;
    if (!chosen) {
      const scan = await scanVirtualOptions(port, opened.container, intent.value, budget, {
        actions,
        firstWindow: candidates,
      });
      actions += scan.cursor.scrolls;
      if (scan.cursor.scrolls > 0) {
        // Bounded count and a structural stop token only — no page text and no
        // host discriminator can reach the ledger through this evidence.
        scrollEvidence = {
          scroll_steps: scan.cursor.scrolls,
          scroll_stop: scan.cursor.stoppedBecause,
        };
      }
      if (scan.kind === 'ambiguous') {
        return widgetFailure(
          'WIDGET_AMBIGUOUS_CHOICE',
          'several-matched-equally',
          `Several offered choices match "${intent.value}" at the same rank.`,
          { offered: scan.offered },
        );
      }
      if (scan.cursor.scrolls > 0) scannedOffered = scan.cursor.offered;
      if (scan.kind === 'match') {
        chosen = scan.candidate;
        substitution = scan.substitution;
      } else offeredEvidence = scan.cursor.offered;
    }

    if (!chosen) {
      // Unchanged code and cause: a list that genuinely does not hold the value
      // fails exactly as it always did, now carrying evidence deduplicated
      // across every window that was mounted.
      return widgetFailure(
        'WIDGET_TARGET_UNREACHABLE',
        choiceSet.semantics === 'declared' ? 'value-not-offered' : 'no-options-offered',
        `The widget does not offer a choice matching "${intent.value}".`,
        choiceSet.semantics === 'declared' ? { offered: offeredEvidence } : {},
      );
    }
    // What the widget offered, across every window that was actually mounted.
    // Reporting only the first window would describe a list the caller never
    // chose from once the driver had to scroll to find the row.
    const offered =
      scannedOffered ??
      candidates
        .filter((candidate) => !candidate.disabled)
        .slice(0, 10)
        .map((candidate) => candidate.name);
    await clickCandidate(port, chosen);
    actions += 1;
    const committed = await readCommitted(port, target);
    // Verified against the option that was clicked, not against the text used
    // to find it: a list asked for a code and offering a name has answered the
    // request, and checking the typed text instead calls that a failure.
    if (!matchesCommitment(committed, chosen.name) && !matchesIntent(committed, intent)) {
      return widgetFailure(
        'WIDGET_NOT_COMMITTED',
        'control-refused-value',
        `The choice "${chosen.name}" was clicked, but "${target.name}" did not commit it.`,
        { committed, observed: committed, offered, chosen: chosen.name },
      );
    }
    const evidence: VerdictEvidence = {
      ...(scrollEvidence ?? {}),
      ...(substitution ? substitutionEvidence(substitution) : {}),
    };
    return {
      ok: true,
      driver: 'listbox',
      committed,
      actions,
      container: opened.container,
      chosen: chosen.name,
      offered,
      ...(substitution ? { substitution } : {}),
      ...(Object.keys(evidence).length > 0 ? { evidence } : {}),
    };
  },
};
