/**
 * The WHERE rung, tested as what it is: a pure comparison of two observations.
 *
 * No port, no fixture, no DOM. `locateEditee` performs no action by design —
 * rung 1 has already sent the whole value — so everything it decides is
 * decidable from the two observations it is handed, and testing it that way is
 * what proves the design rather than merely exercising it.
 */

import { describe, expect, it } from 'vitest';

import { locateEditee, type AgentBrowserObservation, type WidgetTarget } from '../../src/index.js';

function observation(
  interactables: readonly {
    readonly ref: string;
    readonly role?: string;
    readonly name?: string;
    readonly value?: string;
    readonly group?: string;
  }[],
): AgentBrowserObservation {
  return {
    url: 'https://example.test/',
    title: '',
    digest: '',
    digestUnchanged: false,
    interactables: interactables.map((entry) => ({
      ref: entry.ref,
      role: entry.role ?? 'textbox',
      name: entry.name ?? entry.ref,
      ...(entry.value === undefined ? {} : { value: entry.value }),
      ...(entry.group === undefined ? {} : { group: entry.group }),
    })),
  };
}

const trigger: WidgetTarget = {
  ref: 'e1',
  role: 'combobox',
  name: 'Where from?',
  group: null,
  value: null,
};

describe('@no-llm editee resolution', () => {
  it('names the overlay input the page routed the keystrokes into', () => {
    // The run's seq 14/18/24 shape: the addressed trigger stays empty while the
    // overlay the trigger opens takes every character.
    const before = observation([{ ref: 'e1', name: 'Where from?' }]);
    const after = observation([
      { ref: 'e1', name: 'Where from?' },
      { ref: 'e7', name: 'Origin', value: 'DFW', group: 'Search overlay' },
    ]);

    const located = locateEditee(before, after, trigger, 'DFW');

    expect(located).toEqual({
      kind: 'delegated',
      evidence: 'value-appeared-elsewhere',
      target: { ref: 'e7', role: 'textbox', name: 'Origin', group: 'Search overlay', value: 'DFW' },
    });
  });

  it('accepts an interactable the overlay only mounted after typing', () => {
    // The overlay's own input is frequently created by the click that opened
    // it, so requiring it to have existed beforehand would exclude the exact
    // shape this rung is for.
    const before = observation([{ ref: 'e1' }]);
    const after = observation([{ ref: 'e1' }, { ref: 'e9', name: 'Origin', value: 'DFW' }]);

    expect(locateEditee(before, after, trigger, 'DFW')).toMatchObject({
      kind: 'delegated',
      target: { ref: 'e9' },
    });
  });

  it('reports the target itself as the editee when it holds the text', () => {
    const before = observation([{ ref: 'e1' }, { ref: 'e2', value: 'unrelated' }]);
    const after = observation([
      { ref: 'e1', value: 'DFW' },
      { ref: 'e2', value: 'unrelated' },
    ]);

    expect(locateEditee(before, after, trigger, 'DFW')).toEqual({ kind: 'same' });
  });

  it('reports inert when nothing anywhere changed', () => {
    const before = observation([{ ref: 'e1' }, { ref: 'e2', value: 'unrelated' }]);
    const after = observation([{ ref: 'e1' }, { ref: 'e2', value: 'unrelated' }]);

    expect(locateEditee(before, after, trigger, 'DFW')).toEqual({
      kind: 'inert',
      evidence: 'none',
    });
  });

  it('refuses to guess when two other controls both took the text', () => {
    // Re-targeting onto a control the caller never asked for is strictly worse
    // than reporting that mechanism has nothing left to try.
    const before = observation([{ ref: 'e1' }, { ref: 'e2' }, { ref: 'e3' }]);
    const after = observation([
      { ref: 'e1' },
      { ref: 'e2', value: 'DFW' },
      { ref: 'e3', value: 'DFW' },
    ]);

    expect(locateEditee(before, after, trigger, 'DFW')).toEqual({
      kind: 'inert',
      evidence: 'value-appeared-elsewhere',
    });
  });

  it('ignores a control that already held the requested text before typing', () => {
    // Unchanged is not evidence. A recent-search chip showing "DFW" is not the
    // editee, however well its text matches the needle.
    const before = observation([{ ref: 'e1' }, { ref: 'e2', value: 'DFW' }]);
    const after = observation([{ ref: 'e1' }, { ref: 'e2', value: 'DFW' }]);

    expect(locateEditee(before, after, trigger, 'DFW')).toEqual({
      kind: 'inert',
      evidence: 'none',
    });
  });

  it('records focus movement as evidence without letting it choose an editee', () => {
    // Focus moving proves the page reacted; it never proves the value landed on
    // whatever now holds focus, so it stays evidence and never a decision.
    const before = observation([{ ref: 'e1' }, { ref: 'e2' }]);
    const after = observation([{ ref: 'e1' }, { ref: 'e2' }]);

    expect(locateEditee(before, after, trigger, 'DFW', { targetRetainedFocus: false })).toEqual({
      kind: 'inert',
      evidence: 'focus-moved',
    });
  });

  it('treats a control that appended its own formatting as holding the value', () => {
    const before = observation([{ ref: 'e1' }, { ref: 'e5' }]);
    const after = observation([{ ref: 'e1' }, { ref: 'e5', value: 'DFW — Dallas Fort Worth' }]);

    expect(locateEditee(before, after, trigger, 'DFW')).toMatchObject({
      kind: 'delegated',
      target: { ref: 'e5' },
    });
  });

  it('refuses an empty request rather than matching everything', () => {
    const before = observation([{ ref: 'e1' }]);
    const after = observation([{ ref: 'e1' }, { ref: 'e2', value: 'anything' }]);

    expect(locateEditee(before, after, trigger, '   ')).toEqual({
      kind: 'inert',
      evidence: 'none',
    });
  });
});
