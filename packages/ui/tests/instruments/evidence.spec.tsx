// @no-llm
/**
 * EvidencePane, SourceEvidence, ActionEvidence and ProtectedValue
 * (FEAT-066 TASK-006).
 */

import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { BriefAction, BriefSource } from '@yantra/protocol';
import { describe, expect, it, vi } from 'vitest';

import { ACTION_NOT_RECORDED, ActionEvidence } from '../../src/instruments/ActionEvidence.js';
import { EvidencePane, SourceEvidence } from '../../src/instruments/EvidencePane.js';
import {
  PROTECTED_MASK,
  ProtectedValue,
  type ProtectedValueProps,
} from '../../src/instruments/ProtectedValue.js';
import { expectNoAxeViolations } from '../support/axe.js';

const SOURCE: BriefSource = {
  n: 2,
  url: 'https://shop.example/bikes',
  final_url: 'https://shop.example/bikes?ref=1',
  host: 'shop.example',
  title: 'Bikes',
  excerpt: 'The Trail X reaches 120 km.',
  fetched_at: '2026-07-01T10:00:00.000Z',
  published_at: null,
};

const FILL: BriefAction = {
  id: 'A2',
  kind: 'fill',
  label: 'Email',
  label_origin: 'placeholder',
  confidence: 'medium',
  section: 'Sign in',
  ref: 'e9',
  epoch: 3,
  call_id: 'call-6',
  host: 'shop.example',
  verification: { resolution: 'selected_from_offered' },
};

const PASSWORD: BriefAction = {
  id: 'A1',
  kind: 'fill',
  label: 'Password',
  label_origin: 'explicit',
  ref: 'e12',
  epoch: 3,
  call_id: 'call-7',
  host: 'shop.example',
  verification: { withheld: { reason: 'password', verdict: 'unchecked' } },
};

describe('ProtectedValue', () => {
  it('renders a fixed mask, the reason and the verdict', () => {
    const { container } = render(<ProtectedValue reason="password" verdict="exact" />);
    expect(container.textContent).toBe(
      `${PROTECTED_MASK}Protected — a password field (password)readback exact`,
    );
  });

  it('renders the same DOM whatever the hidden value was', () => {
    // Two fills whose secret values differ in length produce identical props, so identical DOM.
    const short = render(<ProtectedValue reason="stored_secret" verdict="exact" />).container
      .innerHTML;
    const long = render(<ProtectedValue reason="stored_secret" verdict="exact" />).container
      .innerHTML;
    expect(short).toBe(long);
  });

  it('has no value or length input', () => {
    // @ts-expect-error -- ProtectedValue takes no value: the type rejects it.
    const valueProps: ProtectedValueProps = { reason: 'password', value: 'hunter2' };
    // @ts-expect-error -- nor a length.
    const lengthProps: ProtectedValueProps = { reason: 'password', length: 7 };
    const { container } = render(
      <>
        <ProtectedValue {...valueProps} />
        <ProtectedValue {...lengthProps} />
      </>,
    );
    // Runtime: an extra prop never reaches the DOM.
    expect(container.textContent).not.toContain('hunter2');
    expect(container.innerHTML).not.toMatch(/hunter2|value=|length/u);
    const masks = [...container.querySelectorAll('[data-part="protected-value"]')].map(
      (n) => n.innerHTML,
    );
    expect(masks[0]).toBe(masks[1]);
  });

  it('hides the mask glyphs from assistive technology', () => {
    const { container } = render(<ProtectedValue reason="autocomplete" />);
    expect(container.querySelector('[aria-hidden="true"]')?.textContent).toBe(PROTECTED_MASK);
  });
});

describe('SourceEvidence', () => {
  it('shows the source, both URLs, times, use and the quote', () => {
    render(<SourceEvidence source={SOURCE} formatTime={(iso) => `at ${iso}`} />);
    expect(screen.getByText('Bikes')).toBeTruthy();
    expect(screen.getByText('shop.example')).toBeTruthy();
    expect(
      screen
        .getByRole('link', { name: /shop\.example\/bikes \(opens in a new tab\)/u })
        .getAttribute('rel'),
    ).toBe('noopener noreferrer');
    expect(screen.getByRole('link', { name: /\?ref=1/u })).toBeTruthy();
    expect(screen.getByText('at 2026-07-01T10:00:00.000Z')).toBeTruthy();
    expect(screen.getByText('Not recorded')).toBeTruthy();
    expect(screen.getByText('cited')).toBeTruthy();
    expect(document.querySelector('blockquote')?.textContent).toBe('The Trail X reaches 120 km.');
  });

  it('says the quote was not recorded when the excerpt is null', () => {
    render(<SourceEvidence source={{ ...SOURCE, excerpt: null, cited: false }} />);
    expect(screen.getByText('Quote not recorded for this run')).toBeTruthy();
    expect(screen.getByText('consulted, not cited')).toBeTruthy();
  });

  it('renders a hostile excerpt as text', () => {
    const { container } = render(
      <SourceEvidence source={{ ...SOURCE, excerpt: '<img src=x onerror=alert(1)>' }} />,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});

describe('ActionEvidence', () => {
  it('shows kind, label provenance, section, target identity and the resolution verbatim', () => {
    const { container } = render(<ActionEvidence action={FILL} />);
    const text = container.textContent ?? '';
    for (const word of [
      'fill',
      'Email',
      'placeholder',
      'medium',
      'Sign in',
      'shop.example',
      'e9',
      '3',
      'call-6',
      'selected_from_offered',
    ]) {
      expect(text).toContain(word);
    }
  });

  it('shows a withheld fill as a ProtectedValue and never a value', () => {
    const { container } = render(<ActionEvidence action={PASSWORD} />);
    expect(
      container.querySelector('[data-part="protected-value"]')?.getAttribute('data-reason'),
    ).toBe('password');
    expect(container.textContent).toContain('readback unchecked');
  });

  it('shows the refusal signal of a refused submit', () => {
    render(
      <ActionEvidence
        action={{
          id: 'A3',
          kind: 'submit_refused',
          label: 'Place order',
          ref: 'e30',
          epoch: 4,
          call_id: 'c9',
          host: 'shop.example',
          signal: 'structural',
        }}
      />,
    );
    expect(screen.getByText('Refused because')).toBeTruthy();
    expect(screen.getByText('structural')).toBeTruthy();
  });

  it('links each capture to the gallery', async () => {
    const onShowCapture = vi.fn();
    render(
      <ActionEvidence
        action={
          {
            id: 'A4',
            kind: 'capture',
            label: 'Confirmation',
            ref: 'e40',
            epoch: 5,
            call_id: 'c10',
            host: 'shop.example',
            artifacts: [
              {
                kind: 'screenshot',
                path: 'screenshots/capture-4-dddddddddddd.png',
                mime_type: 'image/png',
                bytes: 10,
                sha256: 'd'.repeat(64),
                sent_to_model: false,
              },
            ],
          } as BriefAction
        }
        onShowCapture={onShowCapture}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /Show capture/u }));
    expect(onShowCapture).toHaveBeenCalledWith('screenshots/capture-4-dddddddddddd.png');
  });

  it('says the action was not recorded when there is none', () => {
    render(<ActionEvidence action={null} />);
    expect(screen.getByText(ACTION_NOT_RECORDED)).toBeTruthy();
  });
});

describe('EvidencePane', () => {
  function pane(onClose = vi.fn(), onBackReference = vi.fn()) {
    render(
      <EvidencePane
        heading="Source 2"
        onClose={onClose}
        backReferences={[{ targetId: 'finding-1', label: 'Finding 1: Trail X' }]}
        onBackReference={onBackReference}
      >
        <SourceEvidence source={SOURCE} />
      </EvidencePane>,
    );
    return { onClose, onBackReference };
  }

  it('is a labelled complementary region, not a dialog', () => {
    pane();
    expect(screen.getByRole('complementary', { name: 'Evidence' })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('takes a distinct landmark name when several panes share a page', () => {
    render(
      <>
        <EvidencePane heading="Action A1" label="Evidence: action A1" onClose={vi.fn()}>
          <p>one</p>
        </EvidencePane>
        <EvidencePane heading="Action A9" label="Evidence: action A9" onClose={vi.fn()}>
          <p>two</p>
        </EvidencePane>
      </>,
    );
    expect(screen.getByRole('complementary', { name: 'Evidence: action A1' })).toBeTruthy();
    expect(screen.getByRole('complementary', { name: 'Evidence: action A9' })).toBeTruthy();
    expect(screen.queryByRole('complementary', { name: 'Evidence' })).toBeNull();
  });

  it('moves focus to its heading when it opens', () => {
    pane();
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Source 2' }));
  });

  it('closes on Escape and on Close', async () => {
    const { onClose } = pane();
    await userEvent.keyboard('{Escape}');
    await userEvent.click(screen.getByRole('button', { name: 'Close evidence' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('lists the claims citing the evidence as buttons', async () => {
    const { onBackReference } = pane();
    await userEvent.click(screen.getByRole('button', { name: 'Finding 1: Trail X' }));
    expect(onBackReference).toHaveBeenCalledWith('finding-1');
  });

  it('has no axe violations', async () => {
    render(
      <main>
        <EvidencePane heading="Action A1" onClose={() => undefined}>
          <ActionEvidence action={PASSWORD} />
        </EvidencePane>
      </main>,
    );
    await expectNoAxeViolations(document.body);
  });
});
