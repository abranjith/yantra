import { describe, expect, it } from 'vitest';

import {
  formatConfigRef,
  parseConfigRef,
  redactConfigRefs,
  resolveConfigRef,
} from '../../src/config/refs.js';
import type { KeychainProvider } from '../../src/secrets/keychain.js';

function keychain(value: string | null, available = true): KeychainProvider {
  return {
    get: async () => value,
    set: async () => undefined,
    delete: async () => false,
    list: async () => [],
    isAvailable: async () => available,
  };
}

describe('@no-llm config references', () => {
  it.each(['${env:FOO_BAR}', '${secret:tavily.api_key}'])('parses and formats %s', (raw) => {
    const result = parseConfigRef(raw);
    expect(result.isOk).toBe(true);
    if (result.isOk) expect(formatConfigRef(result.value)).toBe(raw);
  });

  it.each(['${env:foo}', '${env:1FOO}', '${secret:_x}', '${other:x}', '${'])(
    'rejects %s and names it',
    (raw) => {
      const result = parseConfigRef(raw);
      expect(result.isOk).toBe(false);
      if (!result.isOk) expect(result.error).toContain(raw);
    },
  );

  it('distinguishes missing environment, missing secret, and unavailable keychain', async () => {
    const envRef = parseConfigRef('${env:MISSING}');
    const secretRef = parseConfigRef('${secret:missing}');
    if (!envRef.isOk || !secretRef.isOk) throw new Error('fixture did not parse');
    const missingEnv = await resolveConfigRef(envRef.value, { env: {}, keychain: keychain(null) });
    const missingSecret = await resolveConfigRef(secretRef.value, {
      env: {},
      keychain: keychain(null),
    });
    const unavailable = await resolveConfigRef(secretRef.value, {
      env: {},
      keychain: keychain(null, false),
    });
    expect(!missingEnv.isOk && missingEnv.error.reason).toBe('missing-env');
    expect(!missingSecret.isOk && missingSecret.error.reason).toBe('missing-secret');
    expect(!unavailable.isOk && unavailable.error.reason).toBe('keychain-unavailable');
  });

  it('never includes resolved canary material in errors or redacted output', async () => {
    const canary = 'CANARY-credential-value';
    const ref = parseConfigRef('${env:API_KEY}');
    if (!ref.isOk) throw new Error('fixture did not parse');
    const resolved = await resolveConfigRef(ref.value, {
      env: { API_KEY: canary },
      keychain: keychain(null),
    });
    expect(resolved).toEqual({ isOk: true, value: canary });
    const rendered = JSON.stringify(redactConfigRefs({ api_key: ref.value }));
    expect(rendered).toContain('${env:API_KEY}');
    expect(rendered).not.toContain(canary);
  });
});
