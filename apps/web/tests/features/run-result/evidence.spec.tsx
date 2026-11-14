// @no-llm
/**
 * Citation evidence in one click (FEAT-066 TASK-006): every chip of every
 * fixture Brief opens the matching source or action; missing and legacy
 * evidence says so; protected values never leak; focus moves to the pane and
 * back; keyboard only works; axe passes with the pane open.
 */

import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { Brief } from '@yantra/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { expectNoAxeViolations } from '../../support/axe.js';
import { brief, briefVariants, briefView, goldenBriefs } from '../../support/briefs.js';
import { FakeRpc, renderAt } from '../../support/fake-rpc.js';
import {
  installIntersectionObserver,
  resetIntersectionObservers,
} from '../../support/intersection-observer.js';
import { useFixedLayout } from '../../support/layout.js';

useFixedLayout(1200, 800);

beforeEach(() => {
  installIntersectionObserver();
});

afterEach(() => {
  resetIntersectionObservers();
});

async function open(value: Brief) {
  const rpc = new FakeRpc()
    .answer('read.run_result', briefView(value))
    .answer('artifact.url', (params) => ({
      url: `/a/${String(params.path)}.mac`,
      expires_at: '2026-11-01T00:05:00.000Z',
    }));
  const rendered = await renderAt(`/runs/${briefView(value).run_id}`, rpc);
  await screen.findByRole('tablist', { name: 'Run views' });
  return rendered;
}

function article(): HTMLElement {
  return document.querySelector('[data-document="brief"]')!;
}

function pane(): HTMLElement {
  return screen.getByRole('complementary', { name: 'Evidence' });
}

describe('one click opens the evidence of every chip', () => {
  const fixtures: [string, Brief][] = [
    ...Object.entries(briefVariants()),
    ...Object.entries(goldenBriefs()),
  ];

  it.each(fixtures)('%s', async (_name, value) => {
    await open(value);
    const chips = within(article()).queryAllByRole('button', { name: /^(Source|Action) /u });
    for (const chip of chips) {
      const label = chip.getAttribute('aria-label')!;
      await userEvent.click(chip);
      await waitFor(() => {
        expect(within(pane()).getByRole('heading', { level: 2 }).textContent).toBe(label);
      });
      if (label.startsWith('Source ')) {
        const n = Number(label.slice('Source '.length));
        expect(
          pane().querySelector('[data-evidence="source"]')?.getAttribute('data-source-n'),
        ).toBe(String(n));
      } else {
        const id = label.slice('Action '.length);
        const recorded = value.actions?.some((action) => action.id === id) ?? false;
        expect(
          pane().querySelector(
            recorded ? `[data-action-id="${id}"]` : '[data-evidence="action-missing"]',
          ),
        ).not.toBeNull();
      }
    }
  });
});

describe('what the pane says', () => {
  it('shows the recorded excerpt as the quote, or says it was not recorded', async () => {
    await open(brief());
    await userEvent.click(within(article()).getAllByRole('button', { name: 'Source 2' })[0]!);
    expect(within(pane()).getByText('The Trail X reaches 120 km on one charge.')).toBeTruthy();

    await userEvent.click(within(article()).getAllByRole('button', { name: 'Source 1' })[0]!);
    expect(within(pane()).getByText('Quote not recorded for this run')).toBeTruthy();
    // One item at a time: the second selection replaced the first.
    expect(screen.getAllByRole('complementary', { name: 'Evidence' })).toHaveLength(1);
  });

  it('says action evidence was not recorded for a legacy Brief without actions', async () => {
    const legacy = brief({ overview: 'The form was filled [A1].' });
    expect(legacy.actions).toBeUndefined();
    await open(legacy);

    await userEvent.click(within(article()).getByRole('button', { name: 'Action A1' }));

    expect(within(pane()).getByText('Action evidence not recorded for this run')).toBeTruthy();
  });

  it('renders a withheld fill as Protected, with its reason and no value or length hint', async () => {
    await open(briefVariants().actions!);
    await userEvent.click(within(article()).getAllByRole('button', { name: 'Action A1' })[0]!);

    const value = pane().querySelector('[data-part="protected-value"]');
    expect(value?.getAttribute('data-reason')).toBe('password');
    expect(value?.textContent).toContain('Protected');
    expect(value?.textContent).toContain('••••••••');
  });

  it('lists the claims citing a source and goes to one on press', async () => {
    await open(brief());
    await userEvent.click(within(article()).getAllByRole('button', { name: 'Source 2' })[0]!);

    const citedBy = within(pane()).getByRole('region', { name: 'Cited by' });
    const claim = within(citedBy).getByRole('button', { name: /^Finding 2:/u });
    await userEvent.click(claim);

    expect(document.activeElement?.id).toBe('finding-2');
  });
});

describe('focus', () => {
  it('moves to the pane heading on press and returns to the chip on Escape', async () => {
    await open(brief());
    const chip = within(article()).getAllByRole('button', { name: 'Source 1' })[0]!;

    await userEvent.click(chip);
    await waitFor(() => {
      expect(document.activeElement).toBe(
        within(pane()).getByRole('heading', { name: 'Source 1' }),
      );
    });
    await userEvent.keyboard('{Escape}');

    expect(screen.queryByRole('complementary', { name: 'Evidence' })).toBeNull();
    expect(document.activeElement).toBe(chip);
  });

  it('returns focus to the chip on Close', async () => {
    await open(brief());
    const chip = within(article()).getAllByRole('button', { name: 'Source 2' })[0]!;
    await userEvent.click(chip);
    await userEvent.click(within(pane()).getByRole('button', { name: 'Close evidence' }));
    expect(document.activeElement).toBe(chip);
  });

  it('works with the keyboard only', async () => {
    await open(brief());
    const chip = within(article()).getAllByRole('button', { name: 'Source 1' })[0]!;
    chip.focus();

    await userEvent.keyboard('{Enter}');
    expect(within(pane()).getByRole('heading', { name: 'Source 1' })).toBeTruthy();
    await userEvent.keyboard('{Escape}');

    expect(document.activeElement).toBe(chip);
  });
});

describe('accessibility', () => {
  it('has no axe violations with the pane open', async () => {
    const { container } = await open(briefVariants().actions!);
    await userEvent.click(within(article()).getAllByRole('button', { name: 'Action A1' })[0]!);
    await expectNoAxeViolations(container);
  });
});
