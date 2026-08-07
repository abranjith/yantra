import { describe, expect, it } from 'vitest';

import type { RawInteractable } from '../../src/discovery/interactable-scan.js';
import { MAX_INTERACTABLES, rankInteractables } from '../../src/discovery/interactables.js';

function raw(overrides: Partial<RawInteractable> = {}): RawInteractable {
  return {
    role: 'button',
    name: 'Go',
    kind: 'button',
    disabled: false,
    top: 0,
    left: 0,
    group: null,
    scope: 'page',
    value: null,
    valuePresent: false,
    checked: null,
    expanded: null,
    selected: null,
    visible: true,
    ...overrides,
  };
}

describe('@no-llm rankInteractables', () => {
  it('filters out invisible elements', () => {
    const result = rankInteractables([raw({ visible: true }), raw({ visible: false })]);
    expect(result).toHaveLength(1);
  });

  it('sorts by viewport top position ascending (reading order)', () => {
    const result = rankInteractables([
      raw({ name: 'third', top: 300 }),
      raw({ name: 'first', top: 10 }),
      raw({ name: 'second', top: 100 }),
    ]);
    expect(result.map((r) => r.name)).toEqual(['first', 'second', 'third']);
  });

  it('uses left position as a stable tie-break within a scope', () => {
    const result = rankInteractables([
      raw({ name: 'right', top: 10, left: 400 }),
      raw({ name: 'left', top: 10, left: 10 }),
    ]);
    expect(result.map((entry) => entry.name)).toEqual(['left', 'right']);
  });

  it('keeps each side-by-side calendar panel contiguous in row-major coordinates', () => {
    const august = Array.from({ length: 3 }, (_, row) =>
      raw({ name: `Aug ${row + 1}`, top: row * 20, left: 10, scope: 'dialog' }),
    );
    const september = Array.from({ length: 3 }, (_, row) =>
      raw({ name: `Sep ${row + 1}`, top: row * 20, left: 400, scope: 'dialog' }),
    );

    // `(top,left)` gives deterministic visual row order: left-panel cell then
    // right-panel cell for each row, with no browser-dependent ties.
    expect(rankInteractables([...september, ...august]).map((entry) => entry.name)).toEqual([
      'Aug 1',
      'Sep 1',
      'Aug 2',
      'Sep 2',
      'Aug 3',
      'Sep 3',
    ]);
  });

  it('ranks visible dialog scope ahead of page chrome regardless of top', () => {
    const result = rankInteractables([
      raw({ name: 'Header', scope: 'page', top: 0 }),
      raw({ name: 'Calendar day', scope: 'dialog', top: 500 }),
    ]);
    expect(result.map((entry) => entry.name)).toEqual(['Calendar day', 'Header']);
  });

  it('caps to MAX_INTERACTABLES by default', () => {
    const many = Array.from({ length: 50 }, (_, i) => raw({ top: i }));
    const result = rankInteractables(many);
    expect(result).toHaveLength(MAX_INTERACTABLES);
  });

  it('honors a custom cap', () => {
    const many = Array.from({ length: 10 }, (_, i) => raw({ top: i }));
    expect(rankInteractables(many, 3)).toHaveLength(3);
  });

  it('strips internal ranking fields (top, visible) from the output shape', () => {
    const result = rankInteractables([raw()]);
    expect(result[0]).toEqual({ role: 'button', name: 'Go', kind: 'button', disabled: false });
  });

  it('returns an empty array for an empty input', () => {
    expect(rankInteractables([])).toEqual([]);
  });

  it('does not mutate the input array', () => {
    const input = [raw({ top: 5 }), raw({ top: 1 })];
    const copy = [...input];
    rankInteractables(input);
    expect(input).toEqual(copy);
  });

  it('preserves disabled flags through ranking', () => {
    const result = rankInteractables([raw({ disabled: true }), raw({ disabled: false, top: 5 })]);
    expect(result[0]?.disabled).toBe(true);
    expect(result[1]?.disabled).toBe(false);
  });
});
