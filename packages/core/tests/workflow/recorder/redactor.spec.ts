/**
 * TASK-007: Value redaction tests
 *
 * Includes:
 * - Unit tests: happy path, non-fill passthrough, value_length computation
 * - Property tests (fast-check): feed N random strings, assert zero substring matches in output
 *
 * Tagged @no-llm — must pass with LLM_PROVIDER=none.
 */

import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { ClickAction, NavigateAction, RawFillAction } from '@yantra/protocol';

import { DefaultCaptureRedactor, defangAttrValue } from '../../../src/workflow/recorder/redactor.js';

const redactor = new DefaultCaptureRedactor();

// ---------------------------------------------------------------------------
// Helpers to build test fixtures
// ---------------------------------------------------------------------------

function makeRawFill(raw_value: string, input_type = 'password' as const): RawFillAction {
  return {
    kind: 'fill',
    element_descriptor: {
      tag: 'input',
      role: 'textbox',
      accessible_name: 'Password',
      visible_text: null,
      attrs_sample: { type: 'password' },
      bounding_rect: { x: 0, y: 0, width: 100, height: 30 },
      in_iframe: false,
      xpath_for_debug: '/html/body/form/input',
    },
    candidate_chain: [],
    ts: new Date().toISOString(),
    url_before: 'https://example.com/login',
    url_after: null,
    raw_value,
    value_length: [...raw_value].length,
    input_type,
  };
}

function makeClick(): ClickAction {
  return {
    kind: 'click',
    element_descriptor: {
      tag: 'button',
      role: 'button',
      accessible_name: 'Sign in',
      visible_text: 'Sign in',
      attrs_sample: { 'data-testid': 'sign-in-btn' },
      bounding_rect: { x: 50, y: 80, width: 120, height: 40 },
      in_iframe: false,
      xpath_for_debug: '/html/body/button',
    },
    candidate_chain: [
      { candidate: { kind: 'testid', value: 'sign-in-btn' }, score: 1.0, rank_reason: 'data-testid' },
    ],
    ts: new Date().toISOString(),
    url_before: 'https://example.com/login',
    url_after: null,
  };
}

function makeNavigate(): NavigateAction {
  return {
    kind: 'navigate',
    ts: new Date().toISOString(),
    url_before: 'about:blank',
    url_after: 'https://example.com',
    navigation_kind: 'address_bar',
    triggered_by_action_index: null,
  };
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

describe('@no-llm DefaultCaptureRedactor', () => {
  describe('fill action redaction', () => {
    it('replaces raw_value with the literal string "<redacted>"', () => {
      const result = redactor.redact(makeRawFill('super-secret-p@ss'));
      expect(result.kind).toBe('fill');
      if (result.kind === 'fill') {
        expect(result.raw_value).toBe('<redacted>');
      }
    });

    it('computes value_length as code-point count (not byte count)', () => {
      // '🔑' is 2 UTF-16 code units but 1 code point
      const emoji = '🔑🔑🔑';
      const result = redactor.redact(makeRawFill(emoji));
      expect(result.kind).toBe('fill');
      if (result.kind === 'fill') {
        expect(result.value_length).toBe(3); // 3 emoji code points
      }
    });

    it('preserves value_length for ASCII strings', () => {
      const raw = 'sk-test-xxxxxxxx';
      const result = redactor.redact(makeRawFill(raw));
      expect(result.kind).toBe('fill');
      if (result.kind === 'fill') {
        expect(result.value_length).toBe(16);
      }
    });

    it('preserves input_type from the raw action', () => {
      const result = redactor.redact(makeRawFill('pass', 'password'));
      expect(result.kind).toBe('fill');
      if (result.kind === 'fill') {
        expect(result.input_type).toBe('password');
      }
    });

    it('preserves element_descriptor and candidate_chain', () => {
      const raw = makeRawFill('my-password');
      const result = redactor.redact(raw);
      expect(result.kind).toBe('fill');
      if (result.kind === 'fill') {
        expect(result.element_descriptor.tag).toBe('input');
        expect(result.candidate_chain).toEqual([]);
      }
    });

    it('handles empty string value', () => {
      const result = redactor.redact(makeRawFill(''));
      expect(result.kind).toBe('fill');
      if (result.kind === 'fill') {
        expect(result.raw_value).toBe('<redacted>');
        expect(result.value_length).toBe(0);
      }
    });

    it('returns a NEW object (does not mutate input)', () => {
      const raw = makeRawFill('secret');
      const rawRef = raw;
      const result = redactor.redact(raw);
      expect(result).not.toBe(rawRef);
      // Input raw_value is untouched by the redactor (the JS string is immutable)
      expect((rawRef as { raw_value: string }).raw_value).toBe('secret');
    });
  });

  describe('non-fill actions passthrough', () => {
    it('passes click actions through unchanged', () => {
      const click = makeClick();
      const result = redactor.redact(click);
      expect(result).toEqual(click);
    });

    it('passes navigate actions through unchanged', () => {
      const nav = makeNavigate();
      const result = redactor.redact(nav);
      expect(result).toEqual(nav);
    });
  });

  // ---------------------------------------------------------------------------
  // Property test — the core redaction guarantee
  // ---------------------------------------------------------------------------

  describe('property test: no typed string survives in redacted output', () => {
    it('for 500 random strings: draft output contains zero substring matches', () => {
      fc.assert(
        fc.property(
          // Generate strings with diverse character sets and lengths.
          // minLength: 12 avoids false positives from short substrings that
          // accidentally appear in fixed descriptor fields like 'Password'.
          fc.array(
            fc.oneof(
              fc.string({ minLength: 12, maxLength: 50 }),
              fc.base64String({ minLength: 12, maxLength: 32 }),
              fc.emailAddress(),
            ),
            { minLength: 1, maxLength: 20 },
          ),
          (strings) => {
            for (const str of strings) {
              const raw = makeRawFill(str);
              const result = redactor.redact(raw);
              const serialized = JSON.stringify(result);

              // The typed string must NOT appear in the serialized output
              expect(serialized).not.toContain(str);
              // raw_value must always be the sentinel
              if (result.kind === 'fill') {
                expect(result.raw_value).toBe('<redacted>');
              }
            }
          },
        ),
        { numRuns: 500 },
      );
    });
  });
});

// ---------------------------------------------------------------------------
// defangAttrValue unit tests
// ---------------------------------------------------------------------------

describe('@no-llm defangAttrValue', () => {
  it('returns value unchanged when no credential pattern matches', () => {
    expect(defangAttrValue('ordinary-value')).toBe('ordinary-value');
  });

  it('defangs sk- prefixed strings (OpenAI-style)', () => {
    expect(defangAttrValue('sk-proj-ABCDEFGHIJKLMNOP')).toBe('<defanged>');
  });

  it('defangs ghp_ prefixed strings (GitHub tokens)', () => {
    expect(defangAttrValue('ghp_ABCDEFGHIJ1234567890')).toBe('<defanged>');
  });

  it('defangs AKIA prefixed strings (AWS access keys)', () => {
    expect(defangAttrValue('AKIAIOSFODNN7EXAMPLE')).toBe('<defanged>');
  });

  it('defangs eyJ prefixed strings (JWTs)', () => {
    expect(defangAttrValue('eyJhbGciOiJIUzI1NiJ9abc')).toBe('<defanged>');
  });
});
