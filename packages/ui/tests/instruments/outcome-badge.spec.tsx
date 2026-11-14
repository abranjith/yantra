// @no-llm
/**
 * OutcomeBadge (FEAT-066 TASK-003): protocol words verbatim, parity with the
 * `yantra list` outcome segment, the separate `interrupted` chip, displayed
 * states, and signal tone never conveyed by color alone.
 */

import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

// The CLI's own formatter: the badge must word every outcome exactly as it does.
import { listOutcomeSegment } from '../../../../apps/cli/src/render/list-outcome.js';
import {
  DISPLAYED_STATE_LABELS,
  OUTCOME_WORDS,
  OutcomeBadge,
  outcomeText,
} from '../../src/instruments/OutcomeBadge.js';
import { expectNoAxeViolations } from '../support/axe.js';

function parts(container: HTMLElement) {
  const outcome = container.querySelector('[data-part="outcome"]');
  const chip = container.querySelector('[data-part="execution-state"]');
  return {
    outcome,
    text: outcome?.querySelector('[data-part="text"]')?.textContent ?? null,
    chip: chip?.textContent ?? null,
  };
}

describe('OutcomeBadge', () => {
  it('lists the five protocol outcome words', () => {
    expect(OUTCOME_WORDS).toEqual(['fulfilled', 'partial', 'handoff', 'failed', 'aborted']);
  });

  it.each(OUTCOME_WORDS)('renders the %s outcome word verbatim beside the status', (word) => {
    const { container } = render(<OutcomeBadge status="completed" taskOutcome={word} />);
    expect(parts(container).text).toBe(`completed ${word}`);
    expect(parts(container).outcome?.getAttribute('data-outcome')).toBe(word);
  });

  it.each([
    ['completed', undefined],
    ['succeeded', 'fulfilled'],
    ['failed', 'failed'],
    ['paused', 'handoff'],
    ['handoff', 'handoff'],
    ['aborted', 'aborted'],
    ['running', undefined],
  ] as const)('matches the yantra list segment for status %s, outcome %s', (status, outcome) => {
    const { container } = render(<OutcomeBadge status={status} taskOutcome={outcome} />);
    expect(parts(container).text).toBe(listOutcomeSegment({ status, taskOutcome: outcome }));
    expect(outcomeText(status, outcome)).toBe(listOutcomeSegment({ status, taskOutcome: outcome }));
  });

  it('shows interrupted as a separate execution-state chip', () => {
    const { container } = render(
      <OutcomeBadge status="failed" taskOutcome="failed" executionState="interrupted" />,
    );
    expect(parts(container)).toMatchObject({ text: 'failed failed', chip: 'interrupted' });
  });

  it('shows no chip for a run that ended on its own', () => {
    const { container } = render(<OutcomeBadge status="completed" taskOutcome="fulfilled" />);
    expect(parts(container).chip).toBeNull();
  });

  it.each(Object.entries(DISPLAYED_STATE_LABELS))(
    'shows the displayed state %s as %j',
    (state, label) => {
      const { container } = render(
        <OutcomeBadge
          status="running"
          displayedState={state as keyof typeof DISPLAYED_STATE_LABELS}
        />,
      );
      expect(parts(container).text).toBe(label);
    },
  );

  it('never says running for a run whose owner cannot be verified', () => {
    const { container } = render(<OutcomeBadge status="running" displayedState="unknown_owner" />);
    expect(parts(container).text).toBe('status unknown');
  });

  it.each([
    ['fulfilled', 'fulfilled', 'text-signal-fulfilled-ink'],
    ['partial', 'caution', 'text-signal-partial-ink'],
    ['handoff', 'caution', 'text-signal-partial-ink'],
    ['failed', 'failed', 'text-signal-failed-ink'],
    ['aborted', 'neutral', 'text-ink-2'],
  ] as const)('gives %s the %s tone with an icon and text', (word, tone, className) => {
    const { container } = render(<OutcomeBadge status="completed" taskOutcome={word} />);
    const outcome = parts(container).outcome!;
    expect(outcome.getAttribute('data-tone')).toBe(tone);
    expect(outcome.className).toContain(className);
    expect(outcome.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(outcome.textContent).toContain(word);
  });

  it('uses semantic utilities only', () => {
    const { container } = render(
      <OutcomeBadge status="failed" taskOutcome="failed" executionState="interrupted" />,
    );
    expect(container.innerHTML).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|oklch\(/iu);
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <div>
        <OutcomeBadge status="completed" taskOutcome="fulfilled" />
        <OutcomeBadge status="failed" taskOutcome="failed" executionState="interrupted" />
        <OutcomeBadge status="running" displayedState="waiting_for_you" />
      </div>,
    );
    await expectNoAxeViolations(container);
  });
});
