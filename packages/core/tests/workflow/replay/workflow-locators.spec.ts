/**
 * Workflow `_locators` → engine chain translation.
 *
 * This is the seam where a persisted locator becomes something the resolver can
 * execute. Its edge cases are not cosmetic: the workflow schema requires a
 * `name` on every role candidate, so "no name constraint" can only be spelled
 * as the empty string — and reading that back as a *matcher* inverts its
 * meaning into "the accessible name must be empty".
 */

import type { LocatorCandidate, WorkflowFile } from '@yantra/protocol';
import { describe, expect, it } from 'vitest';

import type { EngineLocatorChain } from '../../../src/locator/types.js';
import { translate } from '../../../src/workflow/replay/workflow-to-plan.js';

function chainFor(candidates: LocatorCandidate[]): EngineLocatorChain {
  const workflow: WorkflowFile = {
    version: 1,
    name: 'locator-fixture',
    description: null,
    security_class: 'public',
    recorded_with: null,
    params: {},
    secrets: [],
    cookies: 'none',
    steps: [
      {
        id: 's1',
        verb: 'click',
        scope: null,
        requires_confirmation: false,
        confirmation_description: null,
        expected_cost: null,
        consequence: null,
        locator: 's1_locator',
      },
    ],
    outputs: [],
    outputs_unredacted: false,
    _unrecorded_frames: [],
    _locators: { s1_locator: candidates },
  };
  return translate(workflow, {}).locatorTable.s1_locator!;
}

describe('@no-llm workflow _locators → engine chain', () => {
  it('treats an empty recorded name as no name constraint', () => {
    // Regression: `''` is how both the discovery promoter (name_match === null)
    // and the agent-trace fallback spell "unnamed". Passing it through as a
    // matcher made the resolver demand an element whose accessible name is
    // empty — which matches every unnamed element of that role and then fails
    // strict mode as ambiguous.
    const chain = chainFor([{ kind: 'role', role: 'button', name: '' }]);

    expect(chain.candidates).toHaveLength(1);
    expect(chain.candidates[0]?.intent).toEqual({ kind: 'role', role: 'button' });
    expect(chain.candidates[0]?.intent).not.toHaveProperty('name');
  });

  it('treats a whitespace-only recorded name as no name constraint', () => {
    const chain = chainFor([{ kind: 'role', role: 'button', name: '   ' }]);

    expect(chain.candidates[0]?.intent).not.toHaveProperty('name');
  });

  it('keeps a real recorded name as an exact matcher', () => {
    const chain = chainFor([{ kind: 'role', role: 'button', name: 'Trackchevron_right' }]);

    expect(chain.candidates[0]?.intent).toEqual({
      kind: 'role',
      role: 'button',
      name: 'Trackchevron_right',
      exact: true,
    });
  });

  it('compiles a recorded regex name into a RegExp matcher', () => {
    const chain = chainFor([
      { kind: 'role', role: 'button', name: { pattern: '^Track', flags: 'i' } },
    ]);

    const intent = chain.candidates[0]?.intent as { name: RegExp };
    expect(intent.name).toBeInstanceOf(RegExp);
    expect(intent.name.source).toBe('^Track');
    expect(intent.name.flags).toBe('i');
    expect(intent.name.test('tracking numbers')).toBe(true);
  });

  it('preserves candidate order so the ranked chain degrades best-first', () => {
    const chain = chainFor([
      { kind: 'testid', value: 'go' },
      { kind: 'role', role: 'button', name: 'Go' },
      { kind: 'css', value: '#go' },
      { kind: 'xpath', value: '/html[1]/body[1]/button[1]' },
    ]);

    expect(chain.candidates.map((c) => c.intent.kind)).toEqual(['testid', 'role', 'css', 'xpath']);
  });

  it.each([
    ['label', { kind: 'label', value: '  ' } as LocatorCandidate],
    ['placeholder', { kind: 'placeholder', value: '' } as LocatorCandidate],
    ['css', { kind: 'css', value: '' } as LocatorCandidate],
    ['xpath', { kind: 'xpath', value: '   ' } as LocatorCandidate],
    ['testid', { kind: 'testid', value: '' } as LocatorCandidate],
  ])('drops an empty %s candidate rather than matching everything', (_kind, candidate) => {
    const chain = chainFor([candidate, { kind: 'role', role: 'button', name: 'Go' }]);

    expect(chain.candidates).toHaveLength(1);
    expect(chain.candidates[0]?.intent.kind).toBe('role');
  });

  it('yields an empty chain when every recorded candidate is empty', () => {
    // The executor reports this as an unusable locator rather than walking a
    // zero-candidate chain and blaming the page.
    const chain = chainFor([
      { kind: 'css', value: '' },
      { kind: 'label', value: '' },
    ]);

    expect(chain.candidates).toHaveLength(0);
  });

  it('keeps chains strict so an ambiguous locator never picks arbitrarily', () => {
    const chain = chainFor([{ kind: 'role', role: 'button', name: 'Go' }]);

    expect(chain.strict).toBe(true);
  });

  it('marks label and placeholder candidates as exact matchers', () => {
    const chain = chainFor([
      { kind: 'label', value: 'Country' },
      { kind: 'placeholder', value: 'Search' },
    ]);

    expect(chain.candidates[0]?.intent).toEqual({
      kind: 'label',
      text: 'Country',
      exact: true,
    });
    expect(chain.candidates[1]?.intent).toEqual({
      kind: 'placeholder',
      text: 'Search',
      exact: true,
    });
  });
});
