/**
 * The generic differ, tested as properties rather than as scenarios.
 *
 * `diffKeyed` is pure and takes its identity policy as an argument, so every
 * claim worth making about it is a claim about *any* `key` — which is what
 * these tests assert. The cases that matter are the ones where a naive
 * set-based differ answers wrongly: repeated keys, reordering, and a capped
 * sample that must not corrupt an uncapped count.
 */

import { describe, expect, it } from 'vitest';

import { diffKeyed } from '../../src/interaction/differ.js';

interface Entry {
  readonly id: string;
  readonly name: string;
  readonly value?: string;
}

function entry(id: string, name: string, value?: string): Entry {
  return value === undefined ? { id, name } : { id, name, value };
}

const byId = (item: Entry): string => item.id;
const byName = (item: Entry): string => item.name;

describe('@no-llm diffKeyed', () => {
  it('reports no change at all when a list is diffed against itself, for any key', () => {
    const list = [entry('a', 'Search'), entry('b', 'Search'), entry('c', 'Go')];

    for (const key of [byId, byName]) {
      const diff = diffKeyed(list, list, { key });
      expect(diff.appearedCount).toBe(0);
      expect(diff.vanishedCount).toBe(0);
      expect(diff.appeared).toEqual([]);
      expect(diff.vanished).toEqual([]);
      expect(diff.sampleTruncated).toBe(false);
    }
  });

  it('swaps appeared and vanished exactly when the arguments are swapped', () => {
    const before = [entry('a', 'Search'), entry('b', 'Go')];
    const after = [entry('a', 'Search'), entry('c', 'Filter'), entry('d', 'Sort')];

    const forward = diffKeyed(before, after, { key: byId });
    const backward = diffKeyed(after, before, { key: byId });

    expect(forward.appearedCount).toBe(2);
    expect(forward.vanishedCount).toBe(1);
    expect(backward.appearedCount).toBe(forward.vanishedCount);
    expect(backward.vanishedCount).toBe(forward.appearedCount);
    expect(backward.appeared.map(byId)).toEqual(forward.vanished.map(byId));
    expect(backward.vanished.map(byId)).toEqual(forward.appeared.map(byId));
  });

  it('counts multiset surplus, which is what a set-based differ gets wrong', () => {
    // Three same-named controls become five. A set differ answers "no change".
    const before = [entry('a', 'Search'), entry('b', 'Search'), entry('c', 'Search')];
    const after = [
      entry('d', 'Search'),
      entry('e', 'Search'),
      entry('f', 'Search'),
      entry('g', 'Search'),
      entry('h', 'Search'),
    ];

    const diff = diffKeyed(before, after, { key: byName });

    expect(diff.appearedCount).toBe(2);
    expect(diff.vanishedCount).toBe(0);
    expect(diff.appeared).toHaveLength(2);
  });

  it('reports surplus on the before side when the multiset shrinks', () => {
    const before = [entry('a', 'Option'), entry('b', 'Option'), entry('c', 'Option')];
    const after = [entry('d', 'Option')];

    const diff = diffKeyed(before, after, { key: byName });

    expect(diff.vanishedCount).toBe(2);
    expect(diff.appearedCount).toBe(0);
  });

  it('is unaffected by order for a key function that ignores position', () => {
    const before = [entry('a', 'One'), entry('b', 'Two'), entry('c', 'Three')];
    const after = [entry('c', 'Three'), entry('a', 'One'), entry('b', 'Two')];

    const diff = diffKeyed(before, after, { key: byName });

    expect(diff.appearedCount).toBe(0);
    expect(diff.vanishedCount).toBe(0);
  });

  it('keeps counts exact under a zero sample cap and says the sample was cut', () => {
    const before = [entry('a', 'Gone'), entry('b', 'Gone')];
    const after = [entry('c', 'New'), entry('d', 'New'), entry('e', 'New')];

    const diff = diffKeyed(before, after, { key: byName, sampleCap: 0 });

    expect(diff.appearedCount).toBe(3);
    expect(diff.vanishedCount).toBe(2);
    expect(diff.appeared).toEqual([]);
    expect(diff.vanished).toEqual([]);
    expect(diff.sampleTruncated).toBe(true);
  });

  it('fills a sample up to the cap and marks only the overflow', () => {
    const before: Entry[] = [];
    const after = [entry('a', 'X'), entry('b', 'X'), entry('c', 'X')];

    const diff = diffKeyed(before, after, { key: byName, sampleCap: 2 });

    expect(diff.appearedCount).toBe(3);
    expect(diff.appeared).toHaveLength(2);
    expect(diff.sampleTruncated).toBe(true);
  });

  it('does not mark truncation when every surplus entry fits the cap', () => {
    const diff = diffKeyed([], [entry('a', 'X')], { key: byName, sampleCap: 5 });

    expect(diff.appeared).toHaveLength(1);
    expect(diff.sampleTruncated).toBe(false);
  });

  it('invokes `changed` only for keys present on both sides', () => {
    const seen: string[] = [];
    const before = [entry('a', 'One', 'x'), entry('b', 'Two', 'y')];
    const after = [entry('a', 'One', 'x!'), entry('c', 'Three', 'z')];

    const diff = diffKeyed(before, after, {
      key: byId,
      changed: (left, right) => {
        seen.push(left.id);
        return (left.value ?? '') !== (right.value ?? '');
      },
    });

    expect(seen).toEqual(['a']);
    expect(diff.changed).toEqual([
      { before: entry('a', 'One', 'x'), after: entry('a', 'One', 'x!') },
    ]);
  });

  it('reports no changed pairs at all when no predicate is supplied', () => {
    const before = [entry('a', 'One', 'x')];
    const after = [entry('a', 'One', 'y')];

    expect(diffKeyed(before, after, { key: byId }).changed).toEqual([]);
  });

  it('pairs repeated keys positionally so a duplicate does not compare against itself', () => {
    const before = [entry('a', 'Row', '1'), entry('b', 'Row', '2')];
    const after = [entry('c', 'Row', '1'), entry('d', 'Row', '9')];

    const diff = diffKeyed(before, after, {
      key: byName,
      changed: (left, right) => (left.value ?? '') !== (right.value ?? ''),
    });

    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0]!.before.value).toBe('2');
    expect(diff.changed[0]!.after.value).toBe('9');
  });

  it('handles two empty sides without inventing a change', () => {
    const diff = diffKeyed<Entry>([], [], { key: byId });

    expect(diff).toEqual({
      appeared: [],
      vanished: [],
      changed: [],
      appearedCount: 0,
      vanishedCount: 0,
      sampleTruncated: false,
    });
  });
});
