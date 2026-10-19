/** @no-llm Action observations remain in memory; Brief evidence contains no values. */
import { DefaultSanitizer } from '@yantra/core';
import { BriefAction } from '@yantra/protocol';
import { describe, expect, it } from 'vitest';

import {
  ActionObservations,
  actionEvidenceText,
  actionEvidenceView,
  briefActionOf,
} from '../../src/runtime/action-evidence.js';
import { ActionLedger, idOf } from '../../src/runtime/action-ledger.js';

describe('@no-llm ActionObservations', () => {
  const ledger = (): ActionLedger =>
    new ActionLedger({
      sanitizer: new DefaultSanitizer(),
      nowIso: () => '2026-10-18T12:00:00.000Z',
      locate: () => ({ epoch: 3, host: 'forms.example.test' }),
    });
  it('masks and bounds observations, with no serializable own data', () => {
    const observations = new ActionObservations(new DefaultSanitizer(), (text) =>
      text.replaceAll('private-canary', '[INPUT_1]'),
    );
    observations.record('A1', `private-canary ${'x'.repeat(200)}`);
    expect(observations.get('A1')).toHaveLength(120);
    expect(observations.get('A1')).toContain('[INPUT_1]');
    expect(observations.get('A2')).toBeNull();
    expect(JSON.stringify(observations)).toBe('{}');
    expect(Object.keys(observations)).toEqual([]);
  });
  it('links IDs to calls and preserves inferred identity and verification', () => {
    const actions = ledger();
    const entry = actions.record({
      kind: 'fill_committed',
      tool: 'browser_fill_form',
      field: 'First name',
      ref: 'e1',
      groupKey: null,
      covers: 1,
      callId: 'provider-call',
      identity: {
        label: 'First name',
        origin: 'structural',
        confidence: 'medium',
        section: 'Billing',
      },
      verification: { resolution: 'exact', withheld: null },
    });
    const observations = new ActionObservations(new DefaultSanitizer());
    observations.record(idOf(entry), 'Avery');
    const view = actionEvidenceView(actions, observations);
    expect(view.observed('A1')).toBe('Avery');
    expect(actionEvidenceText(entry, view.observed('A1'))).toContain('Avery');
    expect(BriefAction.parse(briefActionOf(entry))).toMatchObject({
      id: 'A1',
      call_id: 'provider-call',
      label_origin: 'structural',
      confidence: 'medium',
      section: 'Billing',
      verification: { resolution: 'exact' },
    });
    expect(JSON.stringify(actions.entries())).not.toContain('Avery');
    expect(JSON.stringify(briefActionOf(entry))).not.toContain('Avery');
  });
  it('never anchors a withheld value, even when accidentally supplied an observation', () => {
    const entry = ledger().record({
      kind: 'fill_committed',
      tool: 'browser_fill_element',
      field: 'Password',
      ref: 'e5',
      groupKey: null,
      covers: 1,
      verification: { resolution: null, withheld: { reason: 'password', verdict: 'exact' } },
    });
    expect(actionEvidenceText(entry, 'protected-canary')).toBe('Filled Password verified exact');
    expect(briefActionOf(entry)).toMatchObject({
      call_id: null,
      verification: { withheld: { reason: 'password', verdict: 'exact' } },
    });
  });
});
