import { describe, expect, it } from 'vitest';

import {
  compactAppliedFill,
  modelProgress,
} from '../../../../src/adapters/pi/tools/browser-common.js';
import type { AppliedBrowserFill } from '../../../../src/adapters/pi/tools/browser-fill-element.js';

const exact: AppliedBrowserFill = {
  field: 'Field',
  ref: 'e1',
  driver: 'plain-text',
  actions: 1,
  dismissed: false,
  requested: 'Blue',
  committed: 'Blue',
  resolution: 'exact',
};

describe('@no-llm compact applied fills', () => {
  it('omits redundant values and reports a semantically exact differing display', () => {
    expect(compactAppliedFill(exact)).toEqual({ field: 'Field', ref: 'e1', resolution: 'exact' });
    expect(compactAppliedFill({ ...exact, committed: 'BLUE' })).toEqual({
      field: 'Field',
      ref: 'e1',
      resolution: 'exact',
      committed: 'BLUE',
    });
  });
  it.each([
    { resolution: 'reformatted' as const },
    { resolution: 'single_offered_match' as const },
    { editee: { ref: 'e2', name: 'Edit', role: 'textbox' } },
    { offered: ['Blue'] },
    { note: 'Resolved' },
    { attempted: [{ strategy: 'overtype', verdict: 'failed' }] },
    {
      attempted: [
        { strategy: 'overtype', verdict: 'succeeded' },
        { strategy: 'native-setter', verdict: 'succeeded' },
      ],
    },
    { substitution: { label: 'Blue', indistinguishable: 2, evidence: [] } },
  ])('preserves recovery and non-exact detail: %j', (changes) => {
    const entry = { ...exact, ...changes } as AppliedBrowserFill;
    expect(compactAppliedFill(entry)).toEqual(entry);
  });
  it('keeps covers and withheld verdicts without adding committed text', () => {
    const withheld = { reason: 'password', verdict: 'exact' as const, ref: 'e1' };
    expect(compactAppliedFill({ ...exact, covers: ['A', 'B'], withheld })).toEqual({
      field: 'Field',
      ref: 'e1',
      resolution: 'exact',
      covers: ['A', 'B'],
      withheld,
    });
  });
  it('does not count skipped typing strategies as recovery', () => {
    expect(
      compactAppliedFill({
        ...exact,
        attempted: [
          { strategy: 'overtype', verdict: 'succeeded' },
          { strategy: 'native-setter', verdict: 'skipped' },
        ],
      }),
    ).toEqual({ field: 'Field', ref: 'e1', resolution: 'exact' });
  });
});

describe('@no-llm bounded model progress', () => {
  it('omits an empty denominator', () =>
    expect(
      modelProgress({ eligible: 0, filled: 0, remaining: [], complete: true }),
    ).toBeUndefined());
  it('keeps ten refs in order and truncates labels to sixty characters', () => {
    const remaining = Array.from({ length: 25 }, (_, i) => ({
      ref: `e${i}`,
      label: 'x'.repeat(200),
      groupKey: null,
    }));
    const result = modelProgress({ eligible: 25, filled: 0, remaining, complete: false })!;
    expect(result).toMatchObject({ eligible: 25, remaining: 25, complete: false });
    expect(result.next.map((e) => e.ref)).toEqual(remaining.slice(0, 10).map((e) => e.ref));
    expect(result.next.every((e) => e.label.length === 60)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(1024);
  });
  it('bounds escaped and multibyte labels by serialized UTF-8 bytes', () => {
    const remaining = Array.from({ length: 10 }, (_, i) => ({
      ref: `e${i}`,
      label: '😀"\\'.repeat(100),
      groupKey: null,
    }));
    const result = modelProgress({ eligible: 10, filled: 0, remaining, complete: true }, (text) =>
      text.replace(/😀/g, '界'),
    )!;
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(1024);
    expect(result.next).toHaveLength(10);
    expect(JSON.stringify(result)).not.toContain('😀');
  });
});
