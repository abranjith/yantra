import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { BudgetTracker, DEFAULT_BUDGET_LIMITS } from '../../src/runtime/budget.js';
import {
  DEFAULT_URL_POLICY_CONFIG,
  UrlPolicy,
  type UrlAuditRecord,
} from '../../src/runtime/url-policy.js';

function makePolicy(): {
  policy: UrlPolicy;
  records: UrlAuditRecord[];
  budgets: BudgetTracker;
} {
  const records: UrlAuditRecord[] = [];
  const budgets = new BudgetTracker(DEFAULT_BUDGET_LIMITS);
  const policy = new UrlPolicy(budgets, DEFAULT_URL_POLICY_CONFIG, {
    record: (entry) => records.push(entry),
  });
  return { policy, records, budgets };
}

describe('@no-llm UrlPolicy acceptance', () => {
  it('accepts a normal https URL and decrements the host budget', () => {
    const { policy, records, budgets } = makePolicy();
    const result = policy.check('https://example.com/articles/42?q=hats');
    expect(result.isOk).toBe(true);
    if (result.isOk) expect(result.value.host).toBe('example.com');
    expect(budgets.snapshot().hosts).toBe(1);
    expect(records.at(-1)).toMatchObject({ decision: 'allow', host: 'example.com' });
  });
});

describe('@no-llm UrlPolicy rejections', () => {
  it('rejects a URL containing an embedded sk- credential with a stable code', () => {
    const { policy, records } = makePolicy();
    const result = policy.check('https://evil.example/collect?leak=sk-ABCDEFGHIJKLMNOPQRSTUVWX');
    expect(result.isOk).toBe(false);
    if (!result.isOk) expect(result.error.code).toBe('URL_CREDENTIAL_SHAPE');
    // The credential value itself is never echoed back — only the URL is audited.
    expect(records.at(-1)).toMatchObject({ decision: 'reject', code: 'URL_CREDENTIAL_SHAPE' });
  });

  it('rejects a JWT (eyJ…) smuggled in the query string', () => {
    const { policy } = makePolicy();
    const jwt = 'eyJhbGciOi.eyJzdWIiOiIx.SflKxwRJSMeKKF2QT';
    const result = policy.check(`https://evil.example/x?t=${jwt}`);
    expect(result.isOk).toBe(false);
    if (!result.isOk) expect(result.error.code).toBe('URL_CREDENTIAL_SHAPE');
  });

  it('rejects an over-long URL before parsing it', () => {
    const { policy } = makePolicy();
    const long = `https://example.com/${'a'.repeat(3000)}`;
    const result = policy.check(long);
    expect(result.isOk).toBe(false);
    if (!result.isOk) expect(result.error.code).toBe('URL_TOO_LONG');
  });

  it('rejects a non-http(s) scheme', () => {
    const { policy } = makePolicy();
    const result = policy.check('file:///etc/passwd');
    expect(result.isOk).toBe(false);
    if (!result.isOk) expect(result.error.code).toBe('URL_INSECURE');
  });

  it('rejects plain http when https is required', () => {
    const { policy } = makePolicy();
    const result = policy.check('http://example.com/');
    expect(result.isOk).toBe(false);
    if (!result.isOk) expect(result.error.code).toBe('URL_INSECURE');
  });

  it('rejects an unparseable URL as retryable', () => {
    const { policy } = makePolicy();
    const result = policy.check('not a url');
    expect(result.isOk).toBe(false);
    if (!result.isOk) {
      expect(result.error.code).toBe('URL_INVALID');
      expect(result.error.retryable).toBe(true);
    }
  });

  it('surfaces host-budget exhaustion as a stable code', () => {
    const records: UrlAuditRecord[] = [];
    const budgets = new BudgetTracker({ ...DEFAULT_BUDGET_LIMITS, maxHosts: 1 });
    const policy = new UrlPolicy(budgets, DEFAULT_URL_POLICY_CONFIG, {
      record: (entry) => records.push(entry),
    });
    expect(policy.check('https://a.com/').isOk).toBe(true);
    const denied = policy.check('https://b.com/');
    expect(denied.isOk).toBe(false);
    if (!denied.isOk) expect(denied.error.code).toBe('BUDGET_EXHAUSTED');
  });
});

describe('@no-llm UrlPolicy property: allowed URLs never exceed the length cap', () => {
  it('never returns ok for a URL longer than the configured cap', () => {
    const budgets = new BudgetTracker(DEFAULT_BUDGET_LIMITS);
    const policy = new UrlPolicy(budgets, { maxUrlLength: 100, requireHttps: true });
    fc.assert(
      fc.property(fc.webUrl(), (url) => {
        const result = policy.check(url);
        if (result.isOk) {
          // Accepted URLs are always within the cap and https.
          expect(url.length).toBeLessThanOrEqual(100);
          expect(result.value.url.startsWith('https://')).toBe(true);
        }
      }),
    );
  });
});
