import { describe, expect, it } from 'vitest';

import type { RawFieldEvidence } from '../../src/discovery/interactable-scan.js';
import {
  deriveFieldIdentity,
  projectFieldIdentity,
  FIELD_IDENTITY_MAX_BYTES,
} from '../../src/interaction/field-identity.js';

export function evidence(overrides: Partial<RawFieldEvidence> = {}): RawFieldEvidence {
  return {
    explicit: null,
    structural: null,
    placeholder: null,
    selectPlaceholder: null,
    title: null,
    inputType: 'text',
    autocomplete: null,
    required: false,
    readOnly: false,
    disabled: false,
    maxLength: null,
    pattern: null,
    section: null,
    htmlName: null,
    htmlId: null,
    radioGroup: null,
    checkboxSet: null,
    humanVerification: false,
    hiddenInput: false,
    ...overrides,
  };
}

describe('@no-llm shared field identity', () => {
  it.each([
    [
      evidence({ explicit: 'Email', structural: { text: 'Wrong', source: 'row', adjacent: true } }),
      'Email',
      'explicit',
      'high',
    ],
    [
      evidence({
        structural: { text: 'Email', source: 'wrapper', adjacent: true },
        placeholder: 'Example',
      }),
      'Email',
      'structural',
      'medium',
    ],
    [
      evidence({ structural: { text: 'Email', source: 'wrapper', adjacent: false } }),
      'Email',
      'structural',
      'low',
    ],
    [evidence({ selectPlaceholder: 'Month' }), 'Month', 'placeholder', 'low'],
    [evidence({ title: 'Town' }), 'Town', 'title', 'low'],
    [evidence({ htmlName: 'field' }), null, 'none', null],
  ])('derives evidence in strength order %#', (facts, label, origin, confidence) => {
    const identity = deriveFieldIdentity('textbox', facts as RawFieldEvidence);
    expect(identity).toMatchObject({ label, origin, confidence });
    if (origin === 'explicit' || origin === 'structural') expect(identity.hint).toBeNull();
  });

  it('keeps sections and delimiter-bearing attributes distinct', () => {
    const billing = deriveFieldIdentity(
      'textbox',
      evidence({ explicit: 'City', section: 'Billing' }),
    );
    const shipping = deriveFieldIdentity(
      'textbox',
      evidence({ explicit: 'City', section: 'Shipping' }),
    );
    expect(billing.identityKey).not.toBe(shipping.identityKey);
    expect(
      deriveFieldIdentity('textbox', evidence({ htmlName: 'a|b', htmlId: 'c' })).identityKey,
    ).not.toBe(
      deriveFieldIdentity('textbox', evidence({ htmlName: 'a', htmlId: 'b|c' })).identityKey,
    );
  });

  it('omits plain explicit metadata and bounds multibyte projections', () => {
    expect(
      projectFieldIdentity(
        'Email',
        deriveFieldIdentity('textbox', evidence({ explicit: 'Email' })),
      ),
    ).toBeUndefined();
    const identity = deriveFieldIdentity(
      'textbox',
      evidence({
        structural: { text: '界'.repeat(80), source: 'wrapper', adjacent: true },
        section: '界'.repeat(60),
        pattern: '.'.repeat(40),
        maxLength: 999,
        required: true,
        autocomplete: 'street-address',
      }),
    );
    const field = projectFieldIdentity('', identity)!;
    expect(Buffer.byteLength(JSON.stringify(field), 'utf8')).toBeLessThanOrEqual(
      FIELD_IDENTITY_MAX_BYTES,
    );
    expect(field).not.toHaveProperty('pattern');
    expect(field).not.toHaveProperty('max_length');
  });
});
