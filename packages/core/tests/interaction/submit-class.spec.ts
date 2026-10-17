import { describe, expect, it } from 'vitest';

import { classifySubmitTarget, type SubmitFacts } from '../../src/interaction/submit-class.js';

const facts = (overrides: Partial<SubmitFacts>): SubmitFacts => ({
  tag: 'button',
  resolvedType: 'submit',
  hasFormOwner: true,
  ...overrides,
});

describe('@no-llm classifySubmitTarget', () => {
  it.each([
    ['a typeless button in a form', facts({}), 'Next', 'structural'],
    ['a type=button button in a form', facts({ resolvedType: 'button' }), 'Add another', null],
    ['a type=reset button in a form', facts({ resolvedType: 'reset' }), 'Clear', null],
    [
      'a typeless button with no form owner (misfire guard)',
      facts({ hasFormOwner: false }),
      'Next',
      null,
    ],
    [
      'an input type=image with an owner',
      facts({ tag: 'input', resolvedType: 'image' }),
      'Go',
      'structural',
    ],
    [
      'an input type=submit with an owner',
      facts({ tag: 'input', resolvedType: 'submit' }),
      'Go',
      'structural',
    ],
    ['an input type=text in a form', facts({ tag: 'input', resolvedType: 'text' }), 'Email', null],
    [
      'a button owned through form= outside its form',
      facts({ hasFormOwner: true }),
      'Send it',
      'structural',
    ],
    [
      'a link named "Submit a ticket"',
      facts({ tag: 'a', resolvedType: null, hasFormOwner: false }),
      'Submit a ticket',
      'name',
    ],
    [
      'a div with role=button and a neutral name',
      facts({ tag: 'div', resolvedType: null, hasFormOwner: false }),
      'Proceed',
      null,
    ],
    [
      'a div with role=button and a protected name',
      facts({ tag: 'div', resolvedType: null, hasFormOwner: false }),
      'Place order',
      'name',
    ],
    ['unreadable facts with a neutral name', null, 'Next', null],
    ['unreadable facts with a protected name', null, 'Pay now', 'name'],
  ] as const)('classifies %s', (_label, input, name, expected) => {
    expect(classifySubmitTarget(input, name)).toBe(expected);
  });

  it('reports the structural signal when both signals fire', () => {
    expect(classifySubmitTarget(facts({}), 'Submit')).toBe('structural');
  });

  it('does not read a submit-typed control of another tag as structural', () => {
    expect(
      classifySubmitTarget(facts({ tag: 'select', resolvedType: 'submit' }), 'Country'),
    ).toBeNull();
  });
});
