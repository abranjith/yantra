import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  resolveIndistinguishableChoice,
  type StructuralChoice,
} from '../../src/interaction/choice.js';

interface Candidate extends StructuralChoice {
  readonly id: string;
  readonly label: string;
}

const resolve = (candidates: readonly Candidate[], containerPath?: readonly number[]) =>
  resolveIndistinguishableChoice(candidates, {
    label: (candidate) => candidate.label,
    ...(containerPath === undefined ? {} : { containerPath }),
  });

describe('@no-llm indistinguishable choice resolution', () => {
  it('applies structural rungs in order and records only rungs that narrow', () => {
    const candidates: Candidate[] = [
      { id: 'outside', label: 'Same', path: [2, 0], selected: true },
      { id: 'disabled', label: 'Same', path: [1, 3], disabled: true },
      { id: 'unselected', label: 'Same', path: [1, 2] },
      { id: 'selected', label: 'Same', path: [1, 1], selected: true },
    ];

    expect(resolve(candidates, [1])).toEqual({
      kind: 'unique',
      choice: candidates[3],
      tieBreak: ['within-container', 'enabled-and-visible', 'page-selected'],
    });
  });

  it('skips a rung that would empty the pool or would not narrow it', () => {
    const candidates: Candidate[] = [
      { id: 'a', label: 'Same', path: [2], disabled: true },
      { id: 'b', label: 'Same', path: [1], disabled: true },
    ];

    const outcome = resolve(candidates, [9]);

    expect(outcome.kind).toBe('substituted');
    if (outcome.kind === 'substituted') {
      expect(outcome.choice.id).toBe('b');
      expect(outcome.substitution.tieBreak).toEqual(['document-order']);
    }
  });

  it('keeps differing model-visible labels ambiguous despite structural differences', () => {
    const candidates: Candidate[] = [
      { id: 'first', label: 'Alpha', path: [1], selected: true },
      { id: 'second', label: 'Beta', path: [2], selected: true },
    ];

    expect(resolve(candidates)).toEqual({ kind: 'ambiguous', survivors: candidates });
  });

  it('normalizes labels before deciding they are indistinguishable', () => {
    const candidates: Candidate[] = [
      { id: 'later', label: '  Same choice ', path: [4] },
      { id: 'earlier', label: 'same   choice', path: [3] },
    ];

    expect(resolve(candidates)).toEqual({
      kind: 'substituted',
      choice: candidates[1],
      substitution: {
        indistinguishable: 2,
        position: 1,
        tieBreak: ['document-order'],
        label: 'same   choice',
      },
    });
  });

  it('returns none for no candidates and unique for one candidate', () => {
    const candidate: Candidate = { id: 'only', label: 'Only', path: [1] };

    expect(resolve([])).toEqual({ kind: 'none' });
    expect(resolve([candidate])).toEqual({ kind: 'unique', choice: candidate, tieBreak: [] });
  });

  const distinctPaths = fc
    .uniqueArray(fc.integer({ min: 0, max: 500 }), { minLength: 2, maxLength: 20 })
    .map((parts) => parts.map((part) => [part] as const));

  it('never substitutes when any surviving model-visible label differs', () => {
    fc.assert(
      fc.property(distinctPaths, (paths) => {
        const candidates = paths.map((path, index) => ({
          id: String(index),
          label: index === paths.length - 1 ? 'Different' : 'Same',
          path,
        }));

        expect(resolve(candidates).kind).not.toBe('substituted');
      }),
    );
  });

  it('always substitutes identical labels with the document-order minimum', () => {
    fc.assert(
      fc.property(distinctPaths, (paths) => {
        const candidates = paths.map((path, index) => ({ id: String(index), label: 'Same', path }));
        const expected = [...candidates].sort((a, b) => a.path[0] - b.path[0])[0]!;
        const outcome = resolve(candidates);

        expect(outcome.kind).toBe('substituted');
        if (outcome.kind === 'substituted') {
          expect(outcome.choice).toBe(expected);
          expect(outcome.substitution.indistinguishable).toBe(candidates.length);
          expect(outcome.substitution.position).toBe(1);
        }
      }),
    );
  });

  it('never chooses outside the resolved container when an in-container candidate exists', () => {
    fc.assert(
      fc.property(distinctPaths, (paths) => {
        const candidates = paths.map((path, index) => ({
          id: String(index),
          label: 'Same',
          path: index === 0 ? ([7, ...path] as const) : ([8, ...path] as const),
        }));
        const outcome = resolve(candidates, [7]);

        expect(outcome.kind).toBe('unique');
        if (outcome.kind === 'unique') expect(outcome.choice.path[0]).toBe(7);
      }),
    );
  });

  it('is invariant under input permutation', () => {
    fc.assert(
      fc.property(distinctPaths, fc.integer(), (paths, seed) => {
        const candidates = paths.map((path, index) => ({ id: String(index), label: 'Same', path }));
        const shuffled = [...candidates].sort(
          (left, right) => ((Number(left.id) * seed) % 17) - ((Number(right.id) * seed) % 17),
        );
        const original = resolve(candidates);
        const permuted = resolve(shuffled);

        expect(original.kind).toBe('substituted');
        expect(permuted.kind).toBe('substituted');
        if (original.kind === 'substituted' && permuted.kind === 'substituted') {
          expect(permuted.choice.path).toEqual(original.choice.path);
          expect(permuted.substitution).toEqual(original.substitution);
        }
      }),
    );
  });
});
