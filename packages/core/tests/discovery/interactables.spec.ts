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
