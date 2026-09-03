/** @no-llm structural obstruction classification, identity, and lexicons. */

import { describe, expect, it } from 'vitest';

import {
  AUTO_CLEARANCE_RE,
  classifyObstruction,
  DISMISS_CANDIDATE_RE,
  fillField,
  ElementObstructedError,
  OBSTRUCTION_CANDIDATE_CAP,
  OBSTRUCTION_CAUSE,
  obstructionDetails,
  OVERLAY_ANCESTRY,
  OVERLAY_NAME_MAX_CHARS,
  PROTECTED_ACTION_RE,
  selectObstructionCandidates,
  type Obstruction,
  type OverlayNodeSummary,
} from '../../src/index.js';
import { WidgetTestPort } from '../support/widget-test-port.js';

function node(overrides: Partial<OverlayNodeSummary> = {}): OverlayNodeSummary {
  return {
    role: 'div',
    name: '',
    ariaBusy: false,
    modal: false,
    position: 'static',
    ...overrides,
  };
}

describe('@no-llm classifyObstruction precedence', () => {
  it('reads a spinner inside a dialog as busy, not as a modal', () => {
    // Busy wins first deliberately: reading a spinner as a modal converts a
    // transient into a terminal and loses a retry the page would have satisfied.
    const chain = [node({ ariaBusy: true }), node({ role: 'dialog', modal: true })];
    expect(classifyObstruction(chain).kind).toBe('busy-indicator');
  });

  it('reads role=progressbar as busy', () => {
    expect(classifyObstruction([node({ role: 'progressbar' })]).kind).toBe('busy-indicator');
  });

  it('reads aria-modal and an open dialog alike as a modal dialog', () => {
    expect(classifyObstruction([node({ modal: true, position: 'fixed' })]).kind).toBe(
      'modal-dialog',
    );
    expect(classifyObstruction([node({ role: 'alertdialog', position: 'fixed' })]).kind).toBe(
      'modal-dialog',
    );
    expect(classifyObstruction([node({ role: 'dialog' })]).kind).toBe('modal-dialog');
  });

  it('reads sticky and fixed alike as a pinned overlay', () => {
    expect(classifyObstruction([node({ position: 'sticky' })]).kind).toBe('fixed-overlay');
    expect(classifyObstruction([node({ position: 'fixed' })]).kind).toBe('fixed-overlay');
  });

  it('reads an absolutely positioned stacking sibling as a plain overlay', () => {
    expect(classifyObstruction([node({ position: 'absolute' })]).kind).toBe('plain-overlay');
    expect(classifyObstruction([node()]).kind).toBe('plain-overlay');
  });

  it('names the outermost container when a listbox is nested inside a modal', () => {
    const chain = [
      node({ role: 'option', name: 'Paris' }),
      node({ role: 'listbox', name: 'Cities', position: 'absolute' }),
      node({ role: 'dialog', name: 'Choose a city', modal: true, position: 'fixed' }),
    ];
    const classified = classifyObstruction(chain);
    expect(classified.kind).toBe('modal-dialog');
    expect(classified.rootIndex).toBe(2);
    expect(classified.identity).toEqual({ role: 'dialog', name: 'Choose a city' });
  });

  it('falls back to the intercepting node when nothing in the chain floats', () => {
    const classified = classifyObstruction([node({ role: 'span', name: 'banner' })]);
    expect(classified.rootIndex).toBe(0);
    expect(classified.identity).toEqual({ role: 'span', name: 'banner' });
  });

  it('looks no further up than OVERLAY_ANCESTRY levels', () => {
    const chain = [
      node(),
      node(),
      node(),
      node(),
      node({ role: 'dialog', name: 'Too far', modal: true }),
    ];
    expect(chain.length).toBeGreaterThan(OVERLAY_ANCESTRY);
    expect(classifyObstruction(chain).kind).toBe('plain-overlay');
  });

  it('collapses and caps a page-derived overlay name', () => {
    const classified = classifyObstruction([
      node({ role: 'dialog', name: `  a\n  b ${'x'.repeat(400)}` }),
    ]);
    expect(classified.identity.name.length).toBe(OVERLAY_NAME_MAX_CHARS);
    expect(classified.identity.name.startsWith('a b ')).toBe(true);
  });

  it('refuses an empty chain rather than inventing an obstruction', () => {
    expect(() => classifyObstruction([])).toThrow();
  });
});

describe('@no-llm dismiss lexicons', () => {
  const offered = (name: string): boolean => DISMISS_CANDIDATE_RE.test(name);
  const pressable = (name: string): boolean =>
    selectObstructionCandidates([{ role: 'button', name, index: 0 }]).selected[0]?.autoClearable ===
    true;

  it('keeps the auto-clearance allowlist a strict subset of the offer lexicon', () => {
    for (const name of [
      'Close',
      'Dismiss',
      'Decline',
      'Reject all',
      'No thanks',
      'Not now',
      'Maybe later',
      'Skip',
    ]) {
      expect(AUTO_CLEARANCE_RE.test(name)).toBe(true);
      expect(offered(name)).toBe(true);
    }
  });

  it('offers but never presses a consent acceptance, a navigation, or a bare glyph', () => {
    for (const name of ['Accept all', 'Continue', 'Sign in']) {
      expect(pressable(name)).toBe(false);
    }
    // Offered, because it is plainly a dismiss affordance; never pressed,
    // because an unlabelled icon is ambiguous by construction.
    expect(offered('×')).toBe(true);
    expect(pressable('×')).toBe(false);
    expect(offered('Continue without an account')).toBe(true);
    expect(pressable('Continue without an account')).toBe(false);
  });

  it('vetoes a close-shaped name that is also a protected action', () => {
    const selection = selectObstructionCandidates([
      { role: 'button', name: 'Confirm and close', index: 0 },
    ]);
    expect(PROTECTED_ACTION_RE.test('Confirm and close')).toBe(true);
    expect(selection.selected[0]).toMatchObject({
      protectedAction: true,
      autoClearable: false,
    });
  });

  it('caps the offer and says so when the cap bites', () => {
    const described = Array.from({ length: 9 }, (_, index) => ({
      role: 'button',
      name: `Close ${index}`,
      index,
    }));
    const selection = selectObstructionCandidates(described);
    expect(selection.selected).toHaveLength(OBSTRUCTION_CANDIDATE_CAP);
    expect(selection.truncated).toBe(true);
  });

  it('drops controls whose names are not dismissal-shaped at all', () => {
    expect(
      selectObstructionCandidates([{ role: 'button', name: 'Search', index: 0 }]).selected,
    ).toHaveLength(0);
    expect(
      selectObstructionCandidates([{ role: 'button', name: '', index: 0 }]).selected,
    ).toHaveLength(0);
  });
});

describe('@no-llm ElementObstructedError', () => {
  const obstruction: Obstruction = {
    kind: 'modal-dialog',
    identity: { role: 'dialog', name: 'Cookie choices' },
    point: { x: 412, y: 268 },
    clearanceAttempted: true,
    clearanceSkipped: null,
    clearanceResult: 'still-obstructed',
    candidates: [
      {
        ref: 'e41',
        role: 'button',
        name: 'Close',
        protectedAction: false,
        autoClearable: true,
      },
    ],
    candidatesTruncated: false,
  };

  it('is never ELEMENT_HIDDEN and carries a required structural kind', () => {
    const error = new ElementObstructedError(obstruction);
    expect(error.code).toBe('ELEMENT_OBSTRUCTED');
    expect(error.code).not.toBe('ELEMENT_HIDDEN');
    expect(error.details.kind).toBe('modal-dialog');
  });

  it('projects snake_cased details that name the offered refs', () => {
    const details = obstructionDetails(obstruction);
    expect(details).toMatchObject({
      kind: 'modal-dialog',
      obstruction: { role: 'dialog', name: 'Cookie choices' },
      point: { x: 412, y: 268 },
      clearance_attempted: true,
      clearance_skipped: null,
      clearance_result: 'still-obstructed',
      candidates: [
        { ref: 'e41', role: 'button', name: 'Close', protected: false, auto_clearable: true },
      ],
      candidates_truncated: false,
    });
  });

  it('reads differently for each kind covering the same control', () => {
    const messages = (
      ['modal-dialog', 'fixed-overlay', 'plain-overlay', 'busy-indicator'] as const
    ).map((kind) => new ElementObstructedError({ ...obstruction, kind }).message);
    expect(new Set(messages).size).toBe(messages.length);
    expect(Object.keys(OBSTRUCTION_CAUSE)).toHaveLength(4);
  });

  it('names a clickable ref in the terminal kinds and no action in the busy one', () => {
    expect(new ElementObstructedError(obstruction).message).toContain('e41');
    const busy = new ElementObstructedError({ ...obstruction, kind: 'busy-indicator' });
    expect(busy.message).not.toContain('browser_click');
    expect(busy.message).toMatch(/settl/i);
  });
});

describe('@no-llm the fill engine does not swallow an obstruction', () => {
  it('lets ELEMENT_OBSTRUCTED reach the caller instead of a widget misdiagnosis', async () => {
    // The engine converts stale-ref failures into WIDGET_ELEMENT_REPLACED and
    // rethrows everything else. That is what keeps a covered field reporting the
    // obstruction rather than degrading into "the control did not commit" — the
    // misdiagnosis this protocol replaces.
    const port = new WidgetTestPort('<label for="q">Where to?</label><input id="q">');
    const ref = port.refFor('#q');
    const blocked = new ElementObstructedError({
      kind: 'modal-dialog',
      identity: { role: 'dialog', name: 'Interstitial' },
      point: { x: 10, y: 20 },
      clearanceAttempted: false,
      clearanceSkipped: 'no-eligible-candidate',
      clearanceResult: null,
      candidates: [],
      candidatesTruncated: false,
    });
    const obstructedPort = {
      ...port,
      observe: port.observe.bind(port),
      click: port.click.bind(port),
      clear: port.clear.bind(port),
      type: port.type.bind(port),
      evaluateOn: port.evaluateOn.bind(port),
      evaluate: port.evaluate.bind(port),
      press: port.press.bind(port),
      now: port.now.bind(port),
      fill: () => Promise.reject(blocked),
    };

    await expect(
      fillField(
        obstructedPort,
        {
          field: 'Where to?',
          target: { ref, role: 'textbox', name: 'Where to?', group: null, value: null },
        },
        { kind: 'text', text: 'Paris' },
        { deadlineMs: port.now() + 5_000, maxActions: 8, maxPagingSteps: 2 },
      ),
    ).rejects.toBe(blocked);
  });
});
