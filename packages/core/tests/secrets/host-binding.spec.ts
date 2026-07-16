import { describe, expect, it } from 'vitest';

import { SecretHostMismatchError, assertHostBinding } from '../../src/secrets/scope-enforcer.js';

describe('@no-llm website secret host binding', () => {
  it('allows an exact host and subdomains of the same registrable domain', () => {
    expect(() =>
      assertHostBinding(
        { kind: 'secret', key: 'site.password', hosts: ['example.com'] },
        'accounts.example.com',
      ),
    ).not.toThrow();
  });

  it('does not collapse two-level public suffixes', () => {
    expect(() =>
      assertHostBinding(
        { kind: 'secret', key: 'site.password', hosts: ['safe.co.uk'] },
        'evil.co.uk',
      ),
    ).toThrow(SecretHostMismatchError);
  });

  it('returns a typed mismatch', () => {
    expect(() =>
      assertHostBinding(
        { kind: 'secret', key: 'site.password', hosts: ['safe.example'] },
        'evil.example',
      ),
    ).toThrow(expect.objectContaining({ code: 'SECRET_HOST_MISMATCH' }));
  });
});
