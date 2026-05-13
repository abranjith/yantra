import { describe, expect, it } from 'vitest';

import { UsageLedger, validateUsageLedgerTotals } from '../src/index.js';

describe('@no-llm usage ledger', () => {
  it('round-trips a usage ledger and validates totals', () => {
    const ledger = UsageLedger.parse({
      run_id: 'run-1',
      calls: [
        {
          step_id: null,
          model: 'claude-opus',
          provider: 'anthropic',
          input_tokens: 10,
          output_tokens: 20,
          cost_estimate_usd: 0.2,
          latency_ms: 100,
          at: '2026-05-12T00:00:00.000Z',
        },
        {
          step_id: 's1',
          model: 'claude-opus',
          provider: 'anthropic',
          input_tokens: 5,
          output_tokens: 8,
          cost_estimate_usd: 0.1,
          latency_ms: 50,
          at: '2026-05-12T00:00:01.000Z',
        },
      ],
      totals: {
        input_tokens: 15,
        output_tokens: 28,
        cost_estimate_usd: 0.30000000000000004,
        call_count: 2,
      },
    });

    expect(validateUsageLedgerTotals(ledger)).toHaveLength(0);
  });

  it('returns warnings instead of rejecting mismatched totals', () => {
    const ledger = UsageLedger.parse({
      run_id: 'run-1',
      calls: [],
      totals: {
        input_tokens: 1,
        output_tokens: 0,
        cost_estimate_usd: null,
        call_count: 1,
      },
    });

    expect(validateUsageLedgerTotals(ledger).length).toBeGreaterThan(0);
  });
});
