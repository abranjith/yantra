import { describe, expect, it } from 'vitest';

import { rankReasonForFailureStage, safeRecordRankSignal } from '../../src/ranking/recording.js';
import type { DomainRankSignal } from '../../src/ranking/types.js';

describe('@no-llm rankReasonForFailureStage', () => {
  it('maps site-caused stages to negative reasons', () => {
    expect(rankReasonForFailureStage('fetch')).toBe('fetch_failed');
    expect(rankReasonForFailureStage('extract')).toBe('extract_failed');
    expect(rankReasonForFailureStage('blocked')).toBe('blocked');
  });

  it('returns null for the run’s own budget and URL-policy refusals', () => {
    expect(rankReasonForFailureStage('budget')).toBeNull();
    expect(rankReasonForFailureStage('policy')).toBeNull();
  });
});

describe('@no-llm safeRecordRankSignal', () => {
  it('delivers to a sink and tolerates a missing or throwing one', () => {
    const seen: DomainRankSignal[] = [];
    const signal: DomainRankSignal = { domain: 'a.example', delta: 1, reason: 'search_result' };

    safeRecordRankSignal({ record: (s) => seen.push(s) }, signal);
    safeRecordRankSignal(null, signal);
    safeRecordRankSignal(
      {
        record: () => {
          throw new Error('sink down');
        },
      },
      signal,
    );

    expect(seen).toEqual([signal]);
  });
});
