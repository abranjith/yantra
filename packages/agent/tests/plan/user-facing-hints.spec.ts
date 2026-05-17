/**
 * @no-llm Tests for the user-facing hint resolver.
 */
import { describe, expect, it } from 'vitest';

import {
  dominantErrorCode,
  resolveUserFacingHint,
  USER_FACING_HINTS,
} from '../../src/plan/user-facing-hints.js';

describe('USER_FACING_HINTS', () => {
  it('covers all ValidationError codes from FEAT-002', () => {
    const expectedCodes = [
      'unknown_locator',
      'scope_violation',
      'undeclared_secret',
      'missing_param',
      'capture_step_not_extract',
      'unknown_capture_step',
      'capture_must_reference_prior_step',
    ];
    for (const code of expectedCodes) {
      expect(USER_FACING_HINTS).toHaveProperty(code);
    }
  });
});

describe('resolveUserFacingHint()', () => {
  it('returns hint for known code', () => {
    expect(resolveUserFacingHint('unknown_locator')).toContain('AI referenced');
  });

  it('returns fallback for null', () => {
    const hint = resolveUserFacingHint(null);
    expect(hint).toContain('AI');
    expect(hint.length).toBeGreaterThan(10);
  });

  it('returns fallback for unknown code', () => {
    const hint = resolveUserFacingHint('totally_unknown_code_xyz');
    expect(hint).toContain('AI');
  });
});

describe('dominantErrorCode()', () => {
  it('returns null for empty array', () => {
    expect(dominantErrorCode([])).toBeNull();
  });

  it('returns single code when only one error', () => {
    expect(dominantErrorCode([{ code: 'unknown_locator' }])).toBe('unknown_locator');
  });

  it('returns most frequent code', () => {
    const errors = [
      { code: 'scope_violation' },
      { code: 'unknown_locator' },
      { code: 'scope_violation' },
      { code: 'scope_violation' },
    ];
    expect(dominantErrorCode(errors)).toBe('scope_violation');
  });

  it('returns first max in tie (deterministic)', () => {
    const errors = [{ code: 'a' }, { code: 'b' }];
    const result = dominantErrorCode(errors);
    expect(['a', 'b']).toContain(result);
  });
});
