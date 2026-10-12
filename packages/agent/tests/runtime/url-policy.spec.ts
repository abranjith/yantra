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
    if (!denied.isOk) {
      expect(denied.error.code).toBe('BUDGET_EXHAUSTED');
      expect(denied.error.budgetLimit).toBe('hosts');
    }
  });

  it('names the navigation limit on a navigation-budget refusal', () => {
    const budgets = new BudgetTracker({ ...DEFAULT_BUDGET_LIMITS, maxNavigations: 1 });
    const policy = new UrlPolicy(budgets, DEFAULT_URL_POLICY_CONFIG);

    expect(policy.check('https://a.com/1').isOk).toBe(true);
    const denied = policy.check('https://a.com/2');

    expect(denied.isOk).toBe(false);
    if (!denied.isOk) expect(denied.error.budgetLimit).toBe('navigations');
  });

  it('sets no budgetLimit on a non-budget refusal', () => {
    const policy = new UrlPolicy(
      new BudgetTracker(DEFAULT_BUDGET_LIMITS),
      DEFAULT_URL_POLICY_CONFIG,
    );

    const denied = policy.check('not a url');

    expect(denied.isOk).toBe(false);
    if (!denied.isOk) expect(denied.error.budgetLimit).toBeUndefined();
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

describe('@no-llm UrlPolicy evaluate/reserve split (FEAT-050)', () => {
  it('evaluate never charges the navigation or host budget', () => {
    const { policy, budgets } = makePolicy();

    for (let i = 0; i < 5; i += 1) {
      expect(policy.evaluate(`https://example.com/${i}`).isOk).toBe(true);
    }

    expect(budgets.snapshot()).toMatchObject({ navigations: 0, hosts: 0 });
  });

  it('reserve charges one navigation per call and a host once', () => {
    const { policy, budgets } = makePolicy();
    const allowed = policy.evaluate('https://example.com/a');
    if (!allowed.isOk) throw new Error('unreachable');

    expect(policy.reserve(allowed.value).isOk).toBe(true);
    expect(policy.reserve(allowed.value).isOk).toBe(true);

    expect(budgets.snapshot()).toMatchObject({ navigations: 2, hosts: 1 });
  });

  it('evaluate still runs every non-budget check', () => {
    const { policy } = makePolicy();

    const refused = policy.evaluate('https://evil.example/x?k=sk-ABCDEFGHIJKLMNOPQRSTUVWX');

    expect(refused.isOk).toBe(false);
    if (!refused.isOk) expect(refused.error.code).toBe('URL_CREDENTIAL_SHAPE');
  });

  it('evaluate passes a URL that a spent budget would refuse, and reserve refuses it', () => {
    const budgets = new BudgetTracker({ ...DEFAULT_BUDGET_LIMITS, maxNavigations: 1 });
    const policy = new UrlPolicy(budgets, DEFAULT_URL_POLICY_CONFIG);
    expect(policy.check('https://a.com/1').isOk).toBe(true);

    const evaluated = policy.evaluate('https://a.com/2');
    expect(evaluated.isOk).toBe(true);
    if (!evaluated.isOk) return;
    const reserved = policy.reserve(evaluated.value);

    expect(reserved.isOk).toBe(false);
    if (!reserved.isOk) {
      expect(reserved.error.code).toBe('BUDGET_EXHAUSTED');
      expect(reserved.error.budgetLimit).toBe('navigations');
    }
  });

  it('check equals evaluate then reserve, in outcome and in budget', () => {
    const left = makePolicy();
    const right = makePolicy();
    const urls = ['https://a.com/1', 'https://b.com/2', 'http://c.com/', 'not a url'];

    for (const url of urls) {
      const checked = left.policy.check(url);
      const evaluated = right.policy.evaluate(url);
      const composed = evaluated.isOk ? right.policy.reserve(evaluated.value) : evaluated;
      expect(composed.isOk).toBe(checked.isOk);
      if (checked.isOk && composed.isOk) expect(composed.value).toEqual(checked.value);
      if (!checked.isOk && !composed.isOk) expect(composed.error.code).toBe(checked.error.code);
    }
    expect(right.budgets.snapshot()).toEqual(left.budgets.snapshot());
  });

  it('keeps check’s audit trail unchanged: exactly one record per call', () => {
    const { policy, records } = makePolicy();

    policy.check('https://a.com/1');
    policy.check('http://insecure.example/');

    expect(records).toEqual([
      { url: 'https://a.com/1', host: 'a.com', decision: 'allow' },
      {
        url: 'http://insecure.example/',
        host: 'insecure.example',
        decision: 'reject',
        code: 'URL_INSECURE',
      },
    ]);
  });

  it('audits a budget refusal from check as one reject and no allow', () => {
    const records: UrlAuditRecord[] = [];
    const budgets = new BudgetTracker({ ...DEFAULT_BUDGET_LIMITS, maxNavigations: 1 });
    const policy = new UrlPolicy(budgets, DEFAULT_URL_POLICY_CONFIG, {
      record: (entry) => records.push(entry),
    });
    policy.check('https://a.com/1');
    records.length = 0;

    policy.check('https://a.com/2');

    expect(records).toEqual([
      { url: 'https://a.com/2', host: 'a.com', decision: 'reject', code: 'BUDGET_EXHAUSTED' },
    ]);
  });

  it('audits evaluate as an allow and a later budget refusal as a reject', () => {
    const records: UrlAuditRecord[] = [];
    const budgets = new BudgetTracker({ ...DEFAULT_BUDGET_LIMITS, maxNavigations: 1 });
    const policy = new UrlPolicy(budgets, DEFAULT_URL_POLICY_CONFIG, {
      record: (entry) => records.push(entry),
    });
    policy.check('https://a.com/1');
    records.length = 0;

    const evaluated = policy.evaluate('https://a.com/2');
    if (evaluated.isOk) policy.reserve(evaluated.value);

    expect(records.map((record) => record.decision)).toEqual(['allow', 'reject']);
  });
});
