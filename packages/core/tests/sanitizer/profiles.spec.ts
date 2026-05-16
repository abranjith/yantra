import { describe, expect, it } from 'vitest';

import { SanitizationProfileError } from '../../src/sanitizer/errors.js';
import { getProfile } from '../../src/sanitizer/profiles.js';

describe('@no-llm sanitizer profile matrix', () => {
  it('public profile enables structural stripping and PII redaction', () => {
    const profile = getProfile('public');

    expect(profile.stripFormValues).toBe(true);
    expect(profile.stripAllQueryStrings).toBe(false);
    expect(profile.stripAuthQueryParams).toBe(true);
    expect(profile.redactPii.email).toBe(true);
    expect(profile.redactPii.ssn).toBe(true);
    expect(profile.redactPii.creditCard).toBe(true);
    expect(profile.redactPii.phone).toBe(true);
    expect(profile.redactPii.apiKeyShapes).toBe(true);
    expect(profile.applyPerHostOverrides).toBe(true);
    expect(profile.bypassForLlmInput).toBe(false);
  });

  it('read-only-data profile bypasses redaction but keeps truncation guardrails', () => {
    const profile = getProfile('read-only-data');

    expect(profile.stripFormValues).toBe(false);
    expect(profile.stripAllQueryStrings).toBe(false);
    expect(profile.stripAuthQueryParams).toBe(false);
    expect(profile.redactPii.email).toBe(false);
    expect(profile.redactPii.ssn).toBe(false);
    expect(profile.redactPii.creditCard).toBe(false);
    expect(profile.redactPii.phone).toBe(false);
    expect(profile.redactPii.apiKeyShapes).toBe(false);
    expect(profile.applyPerHostOverrides).toBe(false);
    expect(profile.bypassForLlmInput).toBe(true);
    expect(profile.truncateBytes).toBe(20_480);
  });

  it('authenticated profile strips all query strings', () => {
    const profile = getProfile('authenticated');

    expect(profile.stripFormValues).toBe(true);
    expect(profile.stripAllQueryStrings).toBe(true);
    expect(profile.stripAuthQueryParams).toBe(true);
    expect(profile.redactPii.email).toBe(true);
    expect(profile.redactPii.ssn).toBe(true);
    expect(profile.redactPii.creditCard).toBe(true);
    expect(profile.redactPii.phone).toBe(true);
    expect(profile.redactPii.apiKeyShapes).toBe(true);
    expect(profile.applyPerHostOverrides).toBe(true);
    expect(profile.bypassForLlmInput).toBe(false);
  });

  it('throws SanitizationProfileError for unknown profile names', () => {
    expect(() => getProfile('does-not-exist')).toThrow(SanitizationProfileError);
  });
});
