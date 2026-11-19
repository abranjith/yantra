import { describe, expect, it } from 'vitest';

import {
  CREDENTIAL_MAX_BYTES,
  CredentialListResult,
  SecretRemoveRequest,
  SecretRemoveResponse,
  SecretSetRequest,
  SecretSetResponse,
  isValidCredentialKey,
} from '../src/index.js';

describe('@no-llm credentials protocol schemas', () => {
  it('validates credential keys using the ${secret:<key>} grammar', () => {
    expect(isValidCredentialKey('tavily.api_key')).toBe(true);
    expect(isValidCredentialKey('anthropic-1')).toBe(true);
    expect(isValidCredentialKey('a')).toBe(true);
    expect(isValidCredentialKey('')).toBe(false);
    expect(isValidCredentialKey('.bad')).toBe(false);
    expect(isValidCredentialKey('bad.')).toBe(false);
    expect(isValidCredentialKey('BAD_KEY')).toBe(false);
    expect(isValidCredentialKey('has space')).toBe(false);
  });

  it('marks SecretSetRequest.value with secret redaction metadata', () => {
    expect(SecretSetRequest.shape.value.description).toBe('secret');
  });

  it('accepts valid SecretSetRequest and rejects empty or oversized values', () => {
    expect(SecretSetRequest.safeParse({ key: 'tavily.api_key', value: 'sk-123' }).success).toBe(
      true,
    );
    expect(SecretSetRequest.safeParse({ key: 'tavily.api_key', value: '' }).success).toBe(false);
    expect(
      SecretSetRequest.safeParse({
        key: 'tavily.api_key',
        value: 'a'.repeat(CREDENTIAL_MAX_BYTES),
      }).success,
    ).toBe(true);
    expect(
      SecretSetRequest.safeParse({
        key: 'tavily.api_key',
        value: 'a'.repeat(CREDENTIAL_MAX_BYTES + 1),
      }).success,
    ).toBe(false);
    // Multi-byte UTF-8 boundary: 2731 * 3 = 8193 bytes > 8192
    expect(
      SecretSetRequest.safeParse({
        key: 'tavily.api_key',
        value: '€'.repeat(2731),
      }).success,
    ).toBe(false);
  });

  it('rejects extra fields such as value on SecretSetResponse and SecretRemoveResponse', () => {
    expect(SecretSetResponse.safeParse({ status: 'set', key: 'tavily.api_key' }).success).toBe(
      true,
    );
    expect(
      SecretSetResponse.safeParse({
        status: 'set',
        key: 'tavily.api_key',
        value: 'CANARY',
      }).success,
    ).toBe(false);

    expect(
      SecretRemoveResponse.safeParse({ status: 'removed', key: 'tavily.api_key' }).success,
    ).toBe(true);
    expect(
      SecretRemoveResponse.safeParse({ status: 'absent', key: 'tavily.api_key' }).success,
    ).toBe(true);
    expect(
      SecretRemoveResponse.safeParse({
        status: 'removed',
        key: 'tavily.api_key',
        value: 'CANARY',
      }).success,
    ).toBe(false);
    expect(SecretRemoveRequest.safeParse({ key: 'BAD' }).success).toBe(false);
  });

  it('parses CredentialListResult with display-only references', () => {
    const parsed = CredentialListResult.parse({
      available: true,
      remedy: null,
      rows: [
        {
          key: 'tavily.api_key',
          source: 'keychain',
          referenced_by: [
            { kind: 'search', id: 'tavily', ref: { kind: 'secret', key: 'tavily.api_key' } },
          ],
        },
        {
          key: 'anthropic/claude-opus-4-7',
          source: 'env',
          referenced_by: [
            {
              kind: 'model',
              id: 'anthropic/claude-opus-4-7',
              ref: { kind: 'env', name: 'ANTHROPIC_API_KEY' },
            },
          ],
        },
      ],
    });
    expect(parsed.rows).toHaveLength(2);
  });
});
