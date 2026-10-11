import { describe, expect, it } from 'vitest';

import { JSON_SCHEMA_ARTIFACTS } from '../src/emit/json-schema.js';
import { RunHealth, type RunHealth as RunHealthType } from '../src/index.js';

function health(overrides: Partial<RunHealthType> = {}): RunHealthType {
  return {
    schema_version: 1,
    run_id: '20260925T130634Z-research-e1fd1b9d',
    searches: {
      total: 22,
      ok: 11,
      failed_by_code: { SEARCH_BLOCKED: 9, SEARCH_NO_RESULTS: 2 },
      providers: ['duckduckgo'],
    },
    fetches: {
      total: 26,
      by_mode: { http: 20, browser: 6 },
      repeat_fetches: 9,
      failed_by_code: { FETCH_TIMEOUT: 1 },
    },
    source_failures: { fetch: 4, extract: 0, blocked: 0, budget: 2, policy: 0 },
    browser: { launches: 3 },
    budgets: {
      navigations_used: 30,
      navigations_limit: 30,
      hosts_used: 12,
      hosts_limit: 20,
      exhausted: ['navigations'],
    },
    tool_failures: {
      total: 12,
      by_code: { SEARCH_BLOCKED: 9, SEARCH_NO_RESULTS: 2, FETCH_TIMEOUT: 1 },
    },
    notices: 5,
    ...overrides,
  };
}

describe('@no-llm RunHealth schema', () => {
  it('round-trips a populated summary', () => {
    const parsed = RunHealth.parse(JSON.parse(JSON.stringify(health())));

    expect(parsed).toEqual(health());
  });

  it('rejects searches.total that disagrees with ok + failed', () => {
    const bad = health({ searches: { ...health().searches, total: 21 } });

    const result = RunHealth.safeParse(bad);

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['searches', 'total']);
  });

  it('rejects fetches.total that disagrees with the by-mode sum', () => {
    const bad = health({ fetches: { ...health().fetches, total: 25 } });

    expect(RunHealth.safeParse(bad).success).toBe(false);
  });

  it('rejects negative or fractional counts and a wrong schema version', () => {
    expect(RunHealth.safeParse(health({ notices: -1 })).success).toBe(false);
    expect(RunHealth.safeParse(health({ notices: 1.5 })).success).toBe(false);
    expect(RunHealth.safeParse({ ...health(), schema_version: 2 }).success).toBe(false);
  });

  it('tolerates a later additive field (FEAT-050 cache_hits)', () => {
    const later = { ...health(), fetches: { ...health().fetches, cache_hits: 4 } };

    expect(RunHealth.safeParse(later).success).toBe(true);
  });

  it('is registered for JSON Schema emission', () => {
    expect(JSON_SCHEMA_ARTIFACTS['run-health.json']?.name).toBe('RunHealth');
  });
});
