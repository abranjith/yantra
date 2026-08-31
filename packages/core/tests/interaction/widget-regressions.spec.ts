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

import {
  fillField,
  type AttemptRecord,
  type WidgetPort,
  type WidgetTarget,
} from '../../src/index.js';
import { WidgetTestPort } from '../support/widget-test-port.js';

const budget = (port: WidgetTestPort) => ({
  deadlineMs: port.now() + 20_000,
  maxActions: 32,
  maxPagingSteps: 12,
});

function target(port: WidgetTestPort, selector: string, role: string, name: string): WidgetTarget {
  return { ref: port.refFor(selector), role, name, group: null, value: null };
}

/**
 * A port that counts what the engine actually did to the page.
 *
 * The brainstorm's north star was "turns spent compensating for tool gaps",
 * which is only observable by reading a live run. An exact action count per
 * fixture is the deterministic stand-in: a change that reintroduces turn-burn —
 * a rung that runs against the wrong node, a picker driven by hand — moves
 * these numbers and fails CI.
 */
function counting(port: WidgetTestPort): {
  readonly port: WidgetPort;
  readonly counts: { clicks: number; entries: number };
} {
  const counts = { clicks: 0, entries: 0 };
  const wrapped: WidgetPort = {
    observe: (options) => port.observe(options),
    click: async (ref) => {
      counts.clicks += 1;
      return port.click(ref);
    },
    fill: async (ref, value) => {
      counts.entries += 1;
      return port.fill(ref, value);
    },
    clear: async (ref) => {
      counts.entries += 1;
      return port.clear(ref);
    },
    type: (ref, text, options) => port.type(ref, text, options),
    evaluateOn: (ref, fn, ...args) => port.evaluateOn(ref, fn, ...args),
    evaluate: (fn, ...args) => port.evaluate(fn, ...args),
    press: (key) => port.press(key),
    now: () => port.now(),
  };
  return { port: wrapped, counts };
}

/** The engine's own recovery ledger, from a success or a failure. */
function attemptsOf(outcome: { readonly ok: boolean }): readonly AttemptRecord[] {
  const success = outcome as { readonly attempted?: readonly AttemptRecord[] };
  const failure = outcome as {
    readonly details?: { readonly attempted?: readonly AttemptRecord[] };
  };
  return success.attempted ?? failure.details?.attempted ?? [];
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

/**
 * Wave 1: the three shapes that cost run `20260829T171218Z-do-0ae073f1` 13.2
 * minutes and 14 of its 33 turns.
 *
 * Assertions are on the **model-visible payload and the action count**, because
 * both are what regressed: the engine varied only *how* it typed, and every
 * failure below was answered by the agent doing the work by hand.
 */
describe('@no-llm interaction recovery axes', () => {
  it('commits through a trigger that routes keystrokes into its overlay', async () => {
    // The run's seq 14, 18 and 24 — three failures costing 8-14 seconds each —
    // as one success. Every typing rung had run against the closed trigger.
    const base = WidgetTestPort.fromFixture('portal-overlay-combobox.html');
    const counted = counting(base);
    const field = target(base, '#trigger', 'combobox', 'Where from?');

    const outcome = await fillField(
      counted.port,
      { field: 'Where from?', target: field },
      { kind: 'text', text: 'San Jose' },
      budget(base),
    );

    expect(outcome).toMatchObject({
      ok: true,
      requested: 'San Jose',
      committed: 'San Jose Mineta International Airport (SJC)',
      editee: { name: 'Search airports', role: 'textbox' },
    });
    const axes = attemptsOf(outcome)
      .filter((record) => record.axis === 'where')
      .map((record) => record.strategy);
    expect(axes).toEqual(['locate-editee', 'retarget-editee']);
    // One entry into the trigger, one into the editee, one click on the
    // suggestion. Anything more is a rung spent on the wrong node.
    expect(counted.counts).toEqual({ entries: 2, clicks: 1 });
  }, 30_000);

  it('reaches an option a leading-characters matcher hides behind a prefix', async () => {
    // The run's seq 24 retype trap: the agent obeyed a hint to re-issue with a
    // full offered label, and the label matched nothing.
    const base = WidgetTestPort.fromFixture('prefix-only-matcher.html');
    const counted = counting(base);
    const field = target(base, '#q', 'combobox', 'Where to?');

    const outcome = await fillField(
      counted.port,
      { field: 'Where to?', target: field },
      { kind: 'text', text: 'San Jose Mineta International Airport (SJC)' },
      budget(base),
    );

    expect(outcome).toMatchObject({
      ok: true,
      committed: 'San Jose Mineta International Airport (SJC)',
      resolution: 'selected_from_offered',
    });
    expect(attemptsOf(outcome).map((record) => record.strategy)).toContain('query:prefix-retreat');
    // Three query forms tried, one click on the match.
    expect(counted.counts).toEqual({ entries: 3, clicks: 1 });
  }, 30_000);

  it('drives a calendar that only exists once the trigger is clicked', async () => {
    // The run's seq 30 and 58, and the eleven browser_click calls the agent
    // made between them because the tool had reported the field unreachable.
    const base = WidgetTestPort.fromFixture('click-to-reveal-calendar.html');
    const counted = counting(base);
    const field = target(base, '#trigger', 'textbox', 'Departure');

    const outcome = await fillField(
      counted.port,
      { field: 'Departure', target: field },
      { kind: 'date', date: '2026-12-02' },
      budget(base),
    );

    expect(outcome).toMatchObject({ ok: true, driver: 'calendar-grid', committed: 'Dec 2, 2026' });
    expect(attemptsOf(outcome).map((record) => record.strategy)).toEqual([
      'open-probe',
      'driver:calendar-grid',
    ]);
    // One probe click, four month pages, one day cell — six, against eleven
    // hand-driven clicks plus eleven model round-trips.
    expect(counted.counts).toEqual({ entries: 0, clicks: 6 });
  }, 30_000);
});
