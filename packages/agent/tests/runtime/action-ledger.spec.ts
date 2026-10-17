import { DefaultSanitizer, UserInputVault } from '@yantra/core';
import { describe, expect, it } from 'vitest';

import { ActionLedger, actionLedgerFor } from '../../src/runtime/action-ledger.js';

function ledgerWith(overrides: Partial<ConstructorParameters<typeof ActionLedger>[0]> = {}): {
  readonly ledger: ActionLedger;
  readonly lines: Record<string, unknown>[];
} {
  const lines: Record<string, unknown>[] = [];
  const keep = (obj: Record<string, unknown> | string) => {
    if (typeof obj !== 'string') lines.push(obj);
  };
  let epoch = 1;
  return {
    lines,
    ledger: new ActionLedger({
      nowIso: () => '2026-10-15T12:00:00.000Z',
      locate: () => ({ epoch: epoch++, host: 'forms.example.test' }),
      sanitizer: new DefaultSanitizer(),
      logger: { info: keep, warn: keep, error: keep, debug: keep },
      ...overrides,
    }),
  };
}

const fill = (field = 'Email') =>
  ({
    kind: 'fill_committed',
    tool: 'browser_fill_form',
    ref: 'e1',
    field,
    groupKey: null,
    covers: 1,
  }) as const;

const capture = (scope: 'viewport' | 'full_page' | 'element' = 'viewport') =>
  ({
    kind: 'capture',
    scope,
    path: 'screenshots/1-abc.png',
    sha256: 'a'.repeat(64),
    bytes: 1024,
    producer: 'browser_screenshot',
  }) as const;

describe('@no-llm ActionLedger', () => {
  it('stamps sequence, time, epoch, and host at record time', () => {
    const { ledger } = ledgerWith();

    const first = ledger.record(fill());
    const second = ledger.record(capture());

    expect(first).toMatchObject({ seq: 1, at: '2026-10-15T12:00:00.000Z', epoch: 1 });
    expect(second).toMatchObject({ seq: 2, epoch: 2, host: 'forms.example.test' });
  });

  it('keeps sequence numbers monotonic and unique under parallel recording', async () => {
    const { ledger } = ledgerWith();

    await Promise.all(
      Array.from({ length: 25 }, async (_, index) => {
        await Promise.resolve();
        ledger.record(fill(`Field ${index}`));
      }),
    );

    const seqs = ledger.entries().map((entry) => entry.seq);
    expect(seqs).toEqual(Array.from({ length: 25 }, (_, index) => index + 1));
  });

  it('returns a copy of its entries', () => {
    const { ledger } = ledgerWith();
    ledger.record(fill());
    (ledger.entries() as unknown[]).pop();
    expect(ledger.entries()).toHaveLength(1);
  });

  it('finds the last committed action, ignoring refusals and captures', () => {
    const { ledger } = ledgerWith();
    expect(ledger.lastCommittedAction()).toBeNull();

    ledger.record(fill());
    ledger.record({
      kind: 'click_executed',
      ref: 'e2',
      name: 'Add another',
      submitClass: null,
    });
    ledger.record({ kind: 'submit_refused', ref: 'e3', name: 'Send', signal: 'structural' });
    ledger.record(capture());

    expect(ledger.lastCommittedAction()).toMatchObject({ kind: 'click_executed', seq: 2 });
  });

  it('lists only the captures recorded after a sequence number', () => {
    const { ledger } = ledgerWith();
    ledger.record(capture('viewport'));
    const action = ledger.record(fill());
    ledger.record(capture('full_page'));
    ledger.record(fill('Name'));

    expect(ledger.capturesAfter(action.seq).map((entry) => entry.scope)).toEqual(['full_page']);
    expect(ledger.capturesAfter(0)).toHaveLength(2);
    expect(ledger.capturesAfter(99)).toEqual([]);
  });

  it('sanitizes, masks, collapses, and bounds names', () => {
    const vault = new UserInputVault();
    vault.redact('my address is jane.private@example.test');
    const { ledger } = ledgerWith({ mask: (text) => vault.mask(text) });

    const masked = ledger.record(fill('Contact jane.private@example.test'));
    const long = ledger.record(fill(`  ${'x'.repeat(100)}   `));
    const clicked = ledger.record({
      kind: 'click_executed',
      ref: 'e9',
      name: `Go\n\n${'y'.repeat(120)}`,
      submitClass: 'name',
    });

    expect(JSON.stringify(masked)).not.toContain('jane.private@example.test');
    expect(masked.kind === 'fill_committed' && masked.field).toContain('Contact');
    expect(long.kind === 'fill_committed' && long.field.length).toBe(60);
    expect(clicked.kind === 'click_executed' && clicked.name.length).toBe(80);
    expect(clicked.kind === 'click_executed' && clicked.name).not.toMatch(/\n/u);
  });

  it('stamps an unknown location when the browser cannot report one', () => {
    const { ledger } = ledgerWith({
      locate: () => {
        throw new Error('page crashed');
      },
    });

    expect(ledger.record(fill())).toMatchObject({ epoch: null, host: '' });
  });

  it('logs one action_recorded line per entry with no names, refs, or paths', () => {
    const { ledger, lines } = ledgerWith();
    ledger.record(fill('Secret Field Label'));
    ledger.record({
      kind: 'click_executed',
      ref: 'e2',
      name: 'Visible Button',
      submitClass: null,
    });
    ledger.record({ kind: 'submit_refused', ref: 'e3', name: 'Send it', signal: 'name' });
    ledger.record(capture('element'));

    expect(lines).toEqual([
      expect.objectContaining({ event: 'action_recorded', kind: 'fill_committed', covers: 1 }),
      expect.objectContaining({ kind: 'click_executed', submit_class: null }),
      expect.objectContaining({ kind: 'submit_refused', signal: 'name' }),
      expect.objectContaining({ kind: 'capture', scope: 'element', bytes: 1024 }),
    ]);
    const serialized = JSON.stringify(lines);
    for (const text of ['Secret Field Label', 'Visible Button', 'Send it', 'e2', 'screenshots/']) {
      expect(serialized).not.toContain(text);
    }
  });

  it('locates through a controller, or stamps unknown without one', () => {
    const located = actionLedgerFor({
      controller: { topLevelDocumentEpoch: () => 4, host: () => 'forms.example.test' },
      sanitizer: new DefaultSanitizer(),
      nowIso: () => '2026-10-15T12:00:00.000Z',
    });
    const headless = actionLedgerFor({
      controller: null,
      sanitizer: new DefaultSanitizer(),
      nowIso: () => '2026-10-15T12:00:00.000Z',
    });

    expect(located.record(fill())).toMatchObject({ epoch: 4, host: 'forms.example.test' });
    expect(headless.record(fill())).toMatchObject({ epoch: null, host: '' });
  });
});
