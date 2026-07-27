/**
 * Engine intent → persisted `_locators` candidate.
 *
 * The conversion is lossy by design, and what it drops matters: a candidate
 * written in a form the workflow schema cannot express is either rejected at
 * save time or silently skipped at replay, so an intent that cannot round-trip
 * faithfully must be dropped here rather than coerced into an approximation
 * that resolves to the wrong element.
 */

import { describe, expect, it } from 'vitest';

import {
  intentToWorkflowCandidate,
  intentsToWorkflowCandidates,
} from '../../src/locator/candidate-codec.js';
import type { JsonLocatorIntent } from '../../src/locator/types.js';

describe('@no-llm intentToWorkflowCandidate', () => {
  it('persists a role intent with its exact name', () => {
    expect(intentToWorkflowCandidate({ kind: 'role', role: 'button', name: 'Go' })).toEqual({
      kind: 'role',
      role: 'button',
      name: 'Go',
    });
  });

  it('persists a nameless role intent as the empty-string spelling', () => {
    // The schema requires `name`, so `''` is the only way to record "no name
    // constraint"; the replay translator reads it back as unconstrained.
    expect(intentToWorkflowCandidate({ kind: 'role', role: 'button' })).toEqual({
      kind: 'role',
      role: 'button',
      name: '',
    });
  });

  it('persists a regex name as its pattern/flags descriptor', () => {
    expect(
      intentToWorkflowCandidate({
        kind: 'role',
        role: 'button',
        name: { __isRegExp: true, pattern: '^Go', flags: 'i' },
      }),
    ).toEqual({ kind: 'role', role: 'button', name: { pattern: '^Go', flags: 'i' } });
  });

  it.each(['listbox', 'searchbox', 'spinbutton', 'slider'])(
    'persists the %s role the engine computes for common form controls',
    (role) => {
      expect(
        intentToWorkflowCandidate({ kind: 'role', role, name: 'x' } as JsonLocatorIntent),
      ).toEqual({ kind: 'role', role, name: 'x' });
    },
  );

  it('drops a role outside the persistable vocabulary rather than coercing it', () => {
    // Coercing (`progressbar` → some near-miss role) would pin a role the
    // resolver never computes for that element — a guaranteed replay miss that
    // looks like a page change.
    expect(
      intentToWorkflowCandidate({
        kind: 'role',
        role: 'progressbar',
        name: 'x',
      } as JsonLocatorIntent),
    ).toBeNull();
  });

  it.each([
    [
      'relative',
      { kind: 'relative', anchor: { kind: 'role', role: 'button' }, relation: 'labeled-by' },
    ],
    ['text', { kind: 'text', text: 'hello' }],
  ])('drops the %s intent, which has no _locators spelling', (_kind, intent) => {
    expect(intentToWorkflowCandidate(intent as JsonLocatorIntent)).toBeNull();
  });

  it.each([
    [
      { kind: 'testid', value: 'go' },
      { kind: 'testid', value: 'go' },
    ],
    [
      { kind: 'label', text: 'Country' },
      { kind: 'label', value: 'Country' },
    ],
    [
      { kind: 'placeholder', text: 'Search' },
      { kind: 'placeholder', value: 'Search' },
    ],
    [
      { kind: 'css', selector: '#go' },
      { kind: 'css', value: '#go' },
    ],
    [
      { kind: 'xpath', expression: '/html[1]' },
      { kind: 'xpath', value: '/html[1]' },
    ],
  ])('maps %o onto its persisted shape', (intent, expected) => {
    expect(intentToWorkflowCandidate(intent as JsonLocatorIntent)).toEqual(expected);
  });

  it.each([
    { kind: 'testid', value: '' },
    { kind: 'label', text: '  ' },
    { kind: 'placeholder', text: '' },
    { kind: 'css', selector: '   ' },
    { kind: 'xpath', expression: '' },
  ])('drops the empty candidate %o', (intent) => {
    expect(intentToWorkflowCandidate(intent as JsonLocatorIntent)).toBeNull();
  });
});

describe('@no-llm intentsToWorkflowCandidates', () => {
  it('keeps rank order while dropping what cannot be persisted', () => {
    const result = intentsToWorkflowCandidates([
      { kind: 'testid', value: 'go' },
      { kind: 'role', role: 'progressbar', name: 'x' },
      { kind: 'role', role: 'button', name: 'Go' },
      { kind: 'relative', anchor: { kind: 'role', role: 'button' }, relation: 'labeled-by' },
      { kind: 'xpath', expression: '/html[1]/body[1]' },
    ] as JsonLocatorIntent[]);

    expect(result.map((c) => c.kind)).toEqual(['testid', 'role', 'xpath']);
  });

  it('returns an empty chain when nothing is persistable', () => {
    expect(
      intentsToWorkflowCandidates([{ kind: 'text', text: 'hi' }] as JsonLocatorIntent[]),
    ).toEqual([]);
  });
});
