/**
 * Behaviour-shaped regressions for the failures in run
 * `20260827T045106Z-do-9a58de7e`.
 *
 * Each fixture reproduces a *shape* — a control that swallows a keystroke, a
 * list that resolves a code to a label, a picker that mounts a duplicate of its
 * own trigger — and is named for that shape, never for a site. The site that
 * exhibited it belongs in the fixture's header comment as evidence, and nowhere
 * in any code path.
 *
 * Assertions are on the **caller-visible result**, because that is what
 * regressed: the engine was already doing better work than it reported, and a
 * test of internal state would have passed throughout.
 */

import { describe, expect, it } from 'vitest';

import { fillField, type WidgetTarget } from '../../src/index.js';
import { WidgetTestPort } from '../support/widget-test-port.js';

const budget = (port: WidgetTestPort) => ({
  deadlineMs: port.now() + 20_000,
  maxActions: 32,
  maxPagingSteps: 12,
});

function target(port: WidgetTestPort, selector: string, role: string, name: string): WidgetTarget {
  return { ref: port.refFor(selector), role, name, group: null, value: null };
}

describe('@no-llm browser interaction regressions', () => {
  it('recovers the whole value from a control that swallows a keystroke', async () => {
    const port = WidgetTestPort.fromFixture('dropped-keystroke-input.html');
    const field = target(port, '#q', 'textbox', 'Where from?');

    const outcome = await fillField(
      port,
      { field: 'Where from?', target: field },
      { kind: 'text', text: 'DFW' },
      budget(port),
    );

    expect(outcome).toMatchObject({ ok: true, committed: 'DFW' });
    expect(port.document.querySelector<HTMLInputElement>('#q')!.value).toBe('DFW');
    const attempted = (outcome.ok ? (outcome.attempted ?? []) : []) as {
      readonly strategy: string;
    }[];
    expect(attempted.map((record) => record.strategy)).toContain('clear-then-type');
  });

  it('reports a code resolved to a label as success, naming both', async () => {
    const port = WidgetTestPort.fromFixture('code-to-label-typeahead.html');
    const field = target(port, '#q', 'combobox', 'Where from?');

    const outcome = await fillField(
      port,
      { field: 'Where from?', target: field },
      { kind: 'text', text: 'DFW' },
      budget(port),
    );

    expect(outcome).toMatchObject({
      ok: true,
      requested: 'DFW',
      committed: 'Dallas',
      resolution: 'single_offered_match',
    });
    expect(outcome.ok && outcome.note).toContain('not a failure');
  });

  it('addresses a field the open picker duplicated, without an ambiguity error', async () => {
    const port = WidgetTestPort.fromFixture('duplicate-trigger-combobox.html');
    const field = target(port, '#page-field', 'combobox', 'Where to?');

    const outcome = await fillField(
      port,
      { field: 'Where to?', target: field },
      { kind: 'text', text: 'San Jose, CA' },
      budget(port),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.committed).toContain('San Jose');
  });

  it('reaches a month four pages away through a read-only date trigger', async () => {
    const port = WidgetTestPort.fromFixture('readonly-date-trigger.html');
    const field = target(port, '#trigger', 'textbox', 'Choose date');

    const outcome = await fillField(
      port,
      { field: 'Choose date', target: field },
      { kind: 'date', date: '2026-12-02' },
      budget(port),
    );

    expect(outcome).toMatchObject({ ok: true, driver: 'calendar-grid' });
    expect(port.document.querySelector<HTMLInputElement>('#trigger')!.value).toBe('Dec 2, 2026');
  });

  it('waits out a suggestion list that arrives long after typing', async () => {
    const port = WidgetTestPort.fromFixture('late-suggestions.html');
    const field = target(port, '#q', 'combobox', 'Going to');

    const outcome = await fillField(
      port,
      { field: 'Going to', target: field },
      { kind: 'text', text: 'Reykjavik' },
      budget(port),
    );

    expect(outcome).toMatchObject({ ok: true, committed: 'Reykjavik, Iceland' });
  }, 25_000);

  it('hands back both choices rather than guessing between them', async () => {
    const port = WidgetTestPort.fromFixture('ambiguous-suggestions.html');
    const field = target(port, '#q', 'combobox', 'Going to');

    const outcome = await fillField(
      port,
      { field: 'Going to', target: field },
      { kind: 'text', text: 'San Jose' },
      budget(port),
    );

    expect(outcome).toMatchObject({ ok: false, errorCode: 'WIDGET_AMBIGUOUS_CHOICE' });
    if (outcome.ok) return;
    expect(outcome.details.offered).toEqual([
      'San Jose, CA, United States',
      'San Jose, Costa Rica',
    ]);
    expect(String(outcome.details.hint)).toContain('exactly as written');
  });

  it('commits the option the caller then names in full', async () => {
    const port = WidgetTestPort.fromFixture('ambiguous-suggestions.html');
    const field = target(port, '#q', 'combobox', 'Going to');

    const outcome = await fillField(
      port,
      { field: 'Going to', target: field },
      { kind: 'text', text: 'San Jose, Costa Rica' },
      budget(port),
    );

    expect(outcome).toMatchObject({ ok: true, committed: 'San Jose, Costa Rica' });
  });
});
