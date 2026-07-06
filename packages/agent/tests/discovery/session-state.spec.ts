import type { DiscoveryCycle } from '@yantra/protocol';
import { describe, expect, it } from 'vitest';

import {
  ZERO_BUDGET_SNAPSHOT,
  appendCycle,
  expandAllowlist,
  initDiscoveryState,
  latestBudgetSnapshot,
  latestObservation,
  trimHistoryForPrompt,
} from '../../src/discovery/session-state.js';

function makeCycle(index: number, overrides: Partial<DiscoveryCycle> = {}): DiscoveryCycle {
  return {
    index,
    proposal: {
      rationale: `rationale ${index}`,
      steps: [
        {
          id: 's1',
          type: 'navigate',
          scope: null,
          requires_confirmation: true,
          confirmation_description: null,
          expected_cost: null,
          consequence: null,
          url: { kind: 'literal', value: 'https://example.com' },
        },
      ],
      done: null,
    },
    validation: { verdict: 'accepted', reasons: [] },
    observation: {
      url: 'https://example.com',
      title: 'Example',
      page_digest: `digest ${index}`,
      interactables: [{ role: 'button', name: 'Go', kind: 'button', disabled: false }],
      step_outcome: 'completed',
      outcome_reason: null,
    },
    budget_after: {
      steps_used: index + 1,
      llm_calls_used: index + 1,
      wall_clock_ms: (index + 1) * 1000,
      cost_usd: 0.01 * (index + 1),
    },
    ...overrides,
  };
}

describe('@no-llm discovery session-state reducer', () => {
  it('initializes with an empty cycle history', () => {
    const state = initDiscoveryState({ goal: 'g', hostAllowlist: ['a.com'] });
    expect(state.cycles).toEqual([]);
    expect(state.goal).toBe('g');
    expect(state.hostAllowlist).toEqual(['a.com']);
  });

  it('appendCycle returns a new object and does not mutate the input', () => {
    const state = initDiscoveryState({ goal: 'g', hostAllowlist: [] });
    const cycle = makeCycle(0);
    const next = appendCycle(state, cycle);
    expect(next).not.toBe(state);
    expect(next.cycles).toEqual([cycle]);
    expect(state.cycles).toEqual([]); // original untouched
  });

  it('latestBudgetSnapshot returns zero before any cycle', () => {
    const state = initDiscoveryState({ goal: 'g', hostAllowlist: [] });
    expect(latestBudgetSnapshot(state)).toEqual(ZERO_BUDGET_SNAPSHOT);
  });

  it('latestBudgetSnapshot returns the last cycle budget_after', () => {
    let state = initDiscoveryState({ goal: 'g', hostAllowlist: [] });
    state = appendCycle(state, makeCycle(0));
    state = appendCycle(state, makeCycle(1));
    expect(latestBudgetSnapshot(state)).toEqual(makeCycle(1).budget_after);
  });

  it('latestObservation returns null before any cycle, then the last observation', () => {
    let state = initDiscoveryState({ goal: 'g', hostAllowlist: [] });
    expect(latestObservation(state)).toBeNull();
    state = appendCycle(state, makeCycle(0));
    expect(latestObservation(state)?.url).toBe('https://example.com');
  });

  it('latestObservation returns null when the last cycle was rejected without execution', () => {
    let state = initDiscoveryState({ goal: 'g', hostAllowlist: [] });
    state = appendCycle(
      state,
      makeCycle(0, { observation: null, validation: { verdict: 'rejected', reasons: ['bad'] } }),
    );
    expect(latestObservation(state)).toBeNull();
  });

  it('expandAllowlist merges and de-duplicates while preserving order', () => {
    const state = initDiscoveryState({ goal: 'g', hostAllowlist: ['a.com', 'b.com'] });
    const next = expandAllowlist(state, ['b.com', 'c.com']);
    expect(next.hostAllowlist).toEqual(['a.com', 'b.com', 'c.com']);
  });

  describe('trimHistoryForPrompt', () => {
    it('keeps all cycles full when there are fewer than the window', () => {
      let state = initDiscoveryState({ goal: 'g', hostAllowlist: [] });
      state = appendCycle(state, makeCycle(0));
      state = appendCycle(state, makeCycle(1));
      const trimmed = trimHistoryForPrompt(state, 3);
      expect(trimmed).toHaveLength(2);
      expect(trimmed.every((c) => c.kind === 'full')).toBe(true);
    });

    it('collapses older cycles to one-line and keeps the last N full at cycle 10', () => {
      let state = initDiscoveryState({ goal: 'g', hostAllowlist: [] });
      for (let i = 0; i < 10; i++) {
        state = appendCycle(state, makeCycle(i));
      }
      const trimmed = trimHistoryForPrompt(state, 3);
      expect(trimmed).toHaveLength(10);
      const oneLineCount = trimmed.filter((c) => c.kind === 'one_line').length;
      const fullCount = trimmed.filter((c) => c.kind === 'full').length;
      expect(oneLineCount).toBe(7);
      expect(fullCount).toBe(3);
      // The full window is the MOST RECENT cycles (7,8,9), in order.
      const fullIndexes = trimmed.filter((c) => c.kind === 'full').map((c) => c.index);
      expect(fullIndexes).toEqual([7, 8, 9]);
    });

    it('renders a one-line summary including verb, outcome, and url', () => {
      let state = initDiscoveryState({ goal: 'g', hostAllowlist: [] });
      for (let i = 0; i < 5; i++) {
        state = appendCycle(state, makeCycle(i));
      }
      const trimmed = trimHistoryForPrompt(state, 3);
      const first = trimmed[0];
      expect(first?.kind).toBe('one_line');
      if (first?.kind === 'one_line') {
        expect(first.summary).toContain('navigate');
        expect(first.summary).toContain('completed');
        expect(first.summary).toContain('https://example.com');
      }
    });

    it('handles an empty history', () => {
      const state = initDiscoveryState({ goal: 'g', hostAllowlist: [] });
      expect(trimHistoryForPrompt(state)).toEqual([]);
    });

    it('describes a fill step with an intent locator role and exact name', () => {
      let state = initDiscoveryState({ goal: 'g', hostAllowlist: [] });
      state = appendCycle(
        state,
        makeCycle(0, {
          proposal: {
            rationale: 'r',
            steps: [
              {
                id: 's1',
                type: 'fill',
                scope: null,
                requires_confirmation: true,
                confirmation_description: null,
                expected_cost: null,
                consequence: null,
                locator: {
                  kind: 'intent',
                  role: 'textbox',
                  name_match: { kind: 'exact', value: 'Search' },
                  near: null,
                },
                value: { kind: 'literal', value: 'shoes' },
                submit: false,
              },
            ],
            done: null,
          },
        }),
      );
      const trimmed = trimHistoryForPrompt(state, 3);
      const first = trimmed[0];
      if (first?.kind === 'full') {
        expect(first.stepsDescription).toContain('fill(textbox "Search")');
      }
    });
  });
});
