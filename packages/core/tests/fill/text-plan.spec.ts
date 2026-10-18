import { describe, expect, it, vi } from 'vitest';

import { buildTextPlan } from '../../src/fill/plans.js';
import { runEscalationPlan } from '../../src/interaction/escalation.js';
import { observeReaction, REACTION_PROBE_MS } from '../../src/widgets/combobox/combobox-driver.js';
import { WidgetTestPort } from '../support/widget-test-port.js';

describe('@no-llm text-plan suggestion entry', () => {
  it.each([
    {
      declared: false,
      popup: false,
      typed: true,
      reaction: 1,
      selection: 0,
      unmet: 'no-suggestion-signal',
    },
    {
      declared: true,
      popup: false,
      typed: true,
      reaction: 0,
      selection: 1,
      unmet: 'suggestions-declared',
    },
    { declared: false, popup: true, typed: true, reaction: 1, selection: 1, unmet: null },
    {
      declared: false,
      popup: false,
      typed: false,
      reaction: 0,
      selection: 0,
      unmet: 'control-not-empty',
    },
  ])('$declared/$popup/$typed follows the declared plan', async (row) => {
    const port = new WidgetTestPort('<input>');
    const runReaction = vi.fn(async () => ({
      ok: true as const,
      value: 'probed',
      evidence: { 'popup-observed': row.popup },
    }));
    const runSelection = vi.fn(async () => ({ ok: true as const, value: 'selected' }));
    const plan = buildTextPlan({
      port,
      budget: { deadlineMs: port.now() + 5000, maxActions: 8 },
      declaredSuggestions: row.declared,
      runEnter: async () => ({
        ok: true as const,
        value: 'typed',
        evidence: { 'text-entered': row.typed },
      }),
      runReaction,
      runSelection,
      classify: () => 'terminal',
    });
    const result = await runEscalationPlan(plan);
    expect(runReaction).toHaveBeenCalledTimes(row.reaction);
    expect(runSelection).toHaveBeenCalledTimes(row.selection);
    if (row.unmet)
      expect(result.ledger.verdicts).toContainEqual(
        expect.objectContaining({ kind: 'skipped', unmet: row.unmet }),
      );
    if (row.selection)
      expect(result.ledger.verdicts).toContainEqual(
        expect.objectContaining({
          rungId: 'watch-and-select',
          entryEvidence: [row.declared ? 'suggestions-declared' : 'popup-observed'],
        }),
      );
    for (const verdict of result.ledger.verdicts)
      if (verdict.kind === 'skipped') expect(typeof verdict.unmet).toBe('string');
  });

  it('bounds actual reaction reads on a stepped clock and reads protected commitment honestly', async () => {
    let tick = 0;
    const port = new WidgetTestPort(
      '<input type="password" value="synthetic-private">',
      () => (tick += 50),
    );
    const target = {
      ref: port.refFor('input'),
      role: 'textbox',
      name: 'Private',
      group: null,
      value: null,
    };
    const read = vi.fn(async () => ({
      container: null,
      ignored: false,
      open: false,
      candidates: [],
      semantics: 'none' as const,
    }));
    const result = await observeReaction(
      port,
      target,
      'synthetic-private',
      { deadlineMs: 10000, maxActions: 8 },
      {},
      read,
    );
    expect(REACTION_PROBE_MS).toBe(325);
    expect(read.mock.calls.length).toBeLessThanOrEqual(4);
    expect(read.mock.calls.length).toBeGreaterThan(0);
    expect(result).toMatchObject({
      popupObserved: false,
      committed: { kind: 'withheld', match: 'exact' },
    });
    expect(JSON.stringify(result)).not.toContain('synthetic-private');
  });

  it('escalates an empty loading popup immediately and stops at an expired deadline', async () => {
    const port = new WidgetTestPort('<input>');
    const target = {
      ref: port.refFor('input'),
      role: 'textbox',
      name: 'Field',
      group: null,
      value: null,
    };
    const read = vi.fn(async () => ({
      container: { path: [1], role: 'listbox', name: '' },
      ignored: false,
      open: true,
      candidates: [],
      semantics: 'declared' as const,
    }));
    expect(
      await observeReaction(
        port,
        target,
        'value',
        { deadlineMs: port.now() + 1000, maxActions: 8 },
        {},
        read,
      ),
    ).toMatchObject({ popupObserved: true });
    expect(read).toHaveBeenCalledOnce();
    read.mockClear();
    expect(
      await observeReaction(port, target, 'value', { deadlineMs: 0, maxActions: 8 }, {}, read),
    ).toMatchObject({ popupObserved: false });
    expect(read).not.toHaveBeenCalled();
  });
});
