/**
 * The combobox family, end to end through the engine.
 *
 * Assertions are on the **caller-visible result** and on what was actually
 * typed, because both are what regressed: the engine was varying only *how* it
 * typed, and a test of internal state would have passed throughout.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  fillField,
  scoreComboboxShape,
  selectByOfferedLabel,
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

function attemptsOf(outcome: { readonly ok: boolean }): readonly AttemptRecord[] {
  const record = outcome as { readonly attempted?: readonly AttemptRecord[] };
  const failure = outcome as {
    readonly details?: { readonly attempted?: readonly AttemptRecord[] };
  };
  return record.attempted ?? failure.details?.attempted ?? [];
}

/** A port that records every value handed to `fill` and `type`. */
function typingSpy(port: WidgetTestPort): {
  readonly port: WidgetPort;
  readonly typed: string[];
  readonly clicks: () => number;
} {
  const typed: string[] = [];
  let clicks = 0;
  const spy: WidgetPort = {
    observe: (options) => port.observe(options),
    click: async (ref) => {
      clicks += 1;
      return port.click(ref);
    },
    fill: async (ref, value) => {
      typed.push(value);
      return port.fill(ref, value);
    },
    clear: (ref) => port.clear(ref),
    type: async (ref, text, options) => {
      typed.push(text);
      return port.type(ref, text, options);
    },
    evaluateOn: (ref, fn, ...args) => port.evaluateOn(ref, fn, ...args),
    evaluate: (fn, ...args) => port.evaluate(fn, ...args),
    press: (key) => port.press(key),
    now: () => port.now(),
  };
  return { port: spy, typed, clicks: () => clicks };
}

describe('@no-llm scoreComboboxShape', () => {
  it.each([
    ['an explicit combobox with list autocomplete', 'prefix-only-matcher.html', '#q', 0.95],
    ['a portal trigger declaring its overlay', 'portal-overlay-combobox.html', '#trigger', 0.95],
  ])('scores %s highly', async (_label, fixture, selector, expected) => {
    const port = WidgetTestPort.fromFixture(fixture);

    const score = await scoreComboboxShape(port, target(port, selector, 'combobox', 'x'));

    expect(score).toBe(expected);
  });

  it('scores a plain text box zero so the plain-text path keeps it', async () => {
    const port = new WidgetTestPort('<input id="q" aria-label="Search">');

    expect(await scoreComboboxShape(port, target(port, '#q', 'textbox', 'Search'))).toBe(0);
  });

  it('scores an editable pointing at a non-list container zero', async () => {
    // Plenty of controls point aria-controls at a status region. Driving one of
    // those as a combobox would type into the page and then rank its error text.
    const port = new WidgetTestPort(
      '<input id="q" aria-label="Search" aria-controls="msg"><div id="msg" role="status">Try again</div>',
    );

    expect(await scoreComboboxShape(port, target(port, '#q', 'textbox', 'Search'))).toBe(0);
  });

  it('never clicks while deciding whether it applies', async () => {
    // Detection is run across every registered driver, which is only safe
    // because it reads closed state. A driver that clicks while deciding would
    // open — or close — a widget nobody asked it to touch.
    const port = WidgetTestPort.fromFixture('portal-overlay-combobox.html');
    const clicked = vi.fn(() => {
      throw new Error('detection must not click');
    });
    const guarded: WidgetPort = { ...portFacade(port), click: clicked as never };

    await scoreComboboxShape(guarded, target(port, '#trigger', 'combobox', 'Where from?'));

    expect(clicked).not.toHaveBeenCalled();
  });
});

describe('@no-llm combobox driver', () => {
  it('finds the editee behind a portal trigger and commits in one call', async () => {
    // The run's three worst failures — seq 14, 18 and 24 — as one success.
    const base = WidgetTestPort.fromFixture('portal-overlay-combobox.html');
    const spy = typingSpy(base);
    const field = target(base, '#trigger', 'combobox', 'Where from?');

    const outcome = await fillField(
      spy.port,
      { field: 'Where from?', target: field },
      { kind: 'text', text: 'San Jose' },
      budget(base),
    );

    expect(outcome).toMatchObject({
      ok: true,
      committed: 'San Jose Mineta International Airport (SJC)',
      editee: { name: 'Search airports' },
    });
    const strategies = attemptsOf(outcome).map((record) => [record.strategy, record.axis]);
    expect(strategies).toContainEqual(['locate-editee', 'where']);
    expect(strategies).toContainEqual(['retarget-editee', 'where']);
    expect(base.document.querySelector<HTMLInputElement>('#trigger')!.value).toBe(
      'San Jose Mineta International Airport (SJC)',
    );
  }, 30_000);

  it('retreats to a prefix a leading-characters matcher will answer', async () => {
    // The run's seq-24 retype trap, end to end: the full offered label matches
    // nothing, and the engine reaches the option anyway.
    const base = WidgetTestPort.fromFixture('prefix-only-matcher.html');
    const spy = typingSpy(base);
    const field = target(base, '#q', 'combobox', 'Where to?');

    const outcome = await fillField(
      spy.port,
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
    // Ranking is against the FULL requested value even though a shortened query
    // was typed; the shortened text alone ties both San Jose entries.
    expect(spy.typed).toContain('San Jose');
  }, 30_000);

  it('records which question each rung varied', async () => {
    const base = WidgetTestPort.fromFixture('prefix-only-matcher.html');
    const field = target(base, '#q', 'combobox', 'Where to?');

    const outcome = await fillField(
      base,
      { field: 'Where to?', target: field },
      { kind: 'text', text: 'San Jose Mineta International Airport (SJC)' },
      budget(base),
    );

    const axes = new Set(attemptsOf(outcome).map((record) => record.axis));
    expect(axes.has('what')).toBe(true);
    expect(axes.has('how')).toBe(true);
  }, 30_000);

  it('hands a genuine tie back rather than guessing, and releases the popup', async () => {
    const port = WidgetTestPort.fromFixture('prefix-only-matcher.html');
    const field = target(port, '#q', 'combobox', 'Where to?');

    const outcome = await fillField(
      port,
      { field: 'Where to?', target: field },
      { kind: 'text', text: 'San Jose' },
      budget(port),
    );

    expect(outcome).toMatchObject({ ok: false, errorCode: 'WIDGET_AMBIGUOUS_CHOICE' });
    if (outcome.ok) return;
    expect(outcome.details.offered).toEqual([
      'San Jose Mineta International Airport (SJC)',
      'San Jose del Cabo (SJD)',
    ]);
    expect(port.document.querySelector<HTMLElement>('#opts')!.style.display).toBe('none');
  }, 30_000);

  it('leaves a plain text box to the plain-text path', async () => {
    const base = new WidgetTestPort('<input id="q" aria-label="Search">');
    const spy = typingSpy(base);
    const field = target(base, '#q', 'textbox', 'Search');

    const outcome = await fillField(
      spy.port,
      { field: 'Search', target: field },
      { kind: 'text', text: 'winter coat' },
      budget(base),
    );

    expect(outcome).toMatchObject({ ok: true, driver: 'plain-text', committed: 'winter coat' });
    expect(attemptsOf(outcome).map((record) => record.strategy)).not.toContain('driver:combobox');
  }, 30_000);
});

describe('@no-llm selectByOfferedLabel', () => {
  it('types a distinguishing prefix, never the whole offered label', async () => {
    // The capability that makes the offered-label hint honest. Retyping the
    // full label into a prefix matcher is the defect, so the assertion is on
    // what was typed rather than only on the result.
    const base = WidgetTestPort.fromFixture('prefix-only-matcher.html');
    const spy = typingSpy(base);
    const field = target(base, '#q', 'combobox', 'Where to?');
    const label = 'San Jose del Cabo (SJD)';

    const outcome = await selectByOfferedLabel(spy.port, field, label, budget(base), [
      'San Jose Mineta International Airport (SJC)',
      label,
    ]);

    expect(outcome).toMatchObject({ ok: true, chosen: label });
    expect(spy.typed).not.toContain(label);
    for (const typed of spy.typed) expect(label.startsWith(typed)).toBe(true);
  }, 30_000);
});

/** The plain object form of the test port, so one method can be overridden. */
function portFacade(port: WidgetTestPort): WidgetPort {
  return {
    observe: (options) => port.observe(options),
    click: (ref) => port.click(ref),
    fill: (ref, value) => port.fill(ref, value),
    clear: (ref) => port.clear(ref),
    type: (ref, text, options) => port.type(ref, text, options),
    evaluateOn: (ref, fn, ...args) => port.evaluateOn(ref, fn, ...args),
    evaluate: (fn, ...args) => port.evaluate(fn, ...args),
    press: (key) => port.press(key),
    now: () => port.now(),
  };
}
