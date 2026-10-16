import { describe, expect, it } from 'vitest';

import {
  classifyFillExemption,
  type FillControlFacts,
} from '../../src/interaction/fill-eligibility.js';

const facts = (overrides: Partial<FillControlFacts> = {}): FillControlFacts => ({
  disabled: false,
  readOnly: false,
  inputType: 'text',
  hidden: false,
  markerText: 'id=email name=email',
  ...overrides,
});

describe('@no-llm classifyFillExemption', () => {
  it.each([
    ['an ordinary text input', facts(), null],
    ['a password input', facts({ inputType: 'password' }), null],
    ['a credit-card number field', facts({ markerText: 'autocomplete=cc-number' }), null],
    ['a new-password field', facts({ markerText: 'autocomplete=new-password' }), null],
    ['a select or textarea', facts({ inputType: null }), null],
    ['a disabled control', facts({ disabled: true }), 'disabled'],
    ['a read-only control', facts({ readOnly: true }), 'read_only'],
    ['a file upload', facts({ inputType: 'file' }), 'file_input'],
    ['a hidden input', facts({ inputType: 'hidden' }), 'hidden'],
    ['a control that is not rendered', facts({ hidden: true }), 'hidden'],
    [
      'a reCAPTCHA response field',
      facts({ markerText: 'class=g-recaptcha-response' }),
      'human_verification',
    ],
    ['a widget with a site key', facts({ markerText: 'data-sitekey' }), 'human_verification'],
    ['a form captcha input', facts({ markerText: 'name=captcha_code' }), 'human_verification'],
    ['an hCaptcha field', facts({ markerText: 'class=H-CAPTCHA' }), 'human_verification'],
  ] as const)('classifies %s', (_label, input, expected) => {
    expect(classifyFillExemption(input)).toBe(expected);
  });

  it('applies the fixed precedence when several exemptions hold', () => {
    const all = facts({
      disabled: true,
      readOnly: true,
      hidden: true,
      inputType: 'file',
      markerText: 'cf-turnstile',
    });
    expect(classifyFillExemption(all)).toBe('human_verification');
    expect(classifyFillExemption({ ...all, markerText: '' })).toBe('hidden');
    expect(classifyFillExemption({ ...all, markerText: '', hidden: false })).toBe('disabled');
    expect(classifyFillExemption({ ...all, markerText: '', hidden: false, disabled: false })).toBe(
      'read_only',
    );
    expect(
      classifyFillExemption({
        ...all,
        markerText: '',
        hidden: false,
        disabled: false,
        readOnly: false,
      }),
    ).toBe('file_input');
  });
});
