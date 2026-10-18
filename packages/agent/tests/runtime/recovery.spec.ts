import { describe, expect, it, vi } from 'vitest';

import {
  buildRecoveryMessage,
  isStalled,
  NEXT_MOVES,
  RecoveryRunner,
  selectNextMove,
  type NextMoveState,
} from '../../src/runtime/recovery.js';

function state(overrides: Partial<NextMoveState> = {}): NextMoveState {
  return {
    items: [],
    coverage: null,
    tools: new Set(['browser_fill_form', 'browser_observe', 'browser_capture', 'result_publish']),
    fieldKinds: true,
    captureScopes: ['viewport', 'element', 'full_page'],
    clean: (t) => t,
    ...overrides,
  };
}
describe('@no-llm FEAT-059 recovery policy', () => {
  it.each([
    [6, 20000, false, true],
    [5, 20000, false, false],
    [2, 121000, false, true],
    [1, 300000, false, false],
    [8, 300000, true, false],
  ])('evaluates %i calls over %ims with soft=%s', (calls, ms, soft, expected) => {
    expect(isStalled({ noProgressCalls: calls, msSinceProgress: ms }, soft)).toBe(expected);
  });
  it('shares a bounded ladder across stall and thinking triggers and rebases each rung', () => {
    const history = { rungs: [], triggers: [], refused_after_freeze: 0, steer_idle: 0 };
    const rebase = vi.fn();
    const runner = new RecoveryRunner(history, rebase);
    expect(runner.onTrigger({ kind: 'stalled', calls: 6, ms: 20 })?.id).toBe('steer');
    expect(runner.onTrigger({ kind: 'turn-timeout', thinkingMs: 120000 })?.id).toBe('freeze');
    expect(runner.onRefusalAfterFreeze(1)).toBeNull();
    expect(runner.onRefusalAfterFreeze(2)?.id).toBe('stop');
    expect(runner.onTrigger({ kind: 'stalled', calls: 6, ms: 20 })).toBeNull();
    expect(history.rungs).toEqual(['steer', 'freeze', 'stop']);
    expect(rebase).toHaveBeenCalledTimes(3);
  });
  it('names only a registered capability, and limits remaining refs in census order', () => {
    const fill = {
      id: 'fill',
      kind: 'fill' as const,
      label: 'fields',
      state: 'advancing' as const,
      done: 1,
      total: 20,
    };
    const s = state({
      items: [fill],
      coverage: {
        eligible: 20,
        filled: 1,
        complete: true,
        remaining: Array.from({ length: 19 }, (_, i) => ({
          ref: `e${i + 2}`,
          label: `Field ${i}`,
          groupKey: null,
        })),
      },
    });
    const move = selectNextMove(s);
    expect(move.id).toBe('fill-remaining');
    expect(move.render(s)).toContain('e11');
    expect(move.render(s)).not.toContain('e12');
    expect(selectNextMove(state({ items: [fill] })).id).toBe('list-fields');
    expect(selectNextMove({ ...s, explorationOpen: false }).id).toBe('publish');
    expect(selectNextMove(state({ items: [fill], tools: new Set(['result_publish']) })).id).toBe(
      'publish',
    );
    expect(
      selectNextMove(
        state({ items: [{ ...fill, id: 'artifact:screenshot:viewport', kind: 'artifact' }] }),
      ).id,
    ).toBe('capture');
    expect(selectNextMove(state()).id).toBe('publish');
    for (const candidate of NEXT_MOVES) expect(s.tools.has(candidate.tool)).toBe(true);
  });
  it('bounds and cleans every interpolated label and keeps a usable Next line', () => {
    const s = state({
      items: [{ id: 'fill', kind: 'fill', label: 'fields', state: 'pending', done: 0, total: 20 }],
      coverage: {
        eligible: 20,
        filled: 0,
        complete: true,
        remaining: Array.from({ length: 20 }, (_, i) => ({
          ref: `e${i + 1}`,
          label: 'CANARY ' + 'x'.repeat(200),
          groupKey: null,
        })),
      },
      clean: (t) => t.replaceAll('CANARY', '[masked]'),
    });
    const result = buildRecoveryMessage({
      rung: 'steer',
      trigger: { kind: 'stalled', calls: 6, ms: 130000 },
      state: s,
      explorationMs: 380000,
      publicationMs: 180000,
    });
    expect(result.message.length).toBeLessThanOrEqual(1200);
    expect(result.message.split('\n')).toHaveLength(5);
    expect(result.message).toContain('Next: call browser_fill_form');
    expect(result.message).not.toContain('CANARY');
    expect(result.message.startsWith('/')).toBe(false);
  });
});
