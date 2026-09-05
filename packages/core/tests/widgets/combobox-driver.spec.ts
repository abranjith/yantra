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
import {
  createRunState,
  escalationLedgerOf,
  toWireLedger,
} from '../../src/interaction/escalation.js';
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
    // The re-target is disclosed by `editee` above and by the WHERE rung that
    // found it. There is no hand-built `retarget-editee` record any more: both
    // typing passes run on the one shared sequence, in order, by construction.
    const strategies = attemptsOf(outcome).map((record) => [record.strategy, record.axis]);
    expect(strategies).toContainEqual(['locate-editee', 'where']);
    expect(strategies).not.toContainEqual(['retarget-editee', 'where']);
    expect(strategies.filter(([strategy]) => strategy === 'overtype').length).toBeGreaterThan(1);
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

describe('@no-llm the query form travels as the rung\u2019s entry evidence', () => {
  const runFor = (port: WidgetTestPort) =>
    createRunState(
      { deadlineMs: port.now() + 20_000, maxActions: 32, maxReacquisitions: 4 },
      port.now(),
    );

  const wireOf = (run: ReturnType<typeof createRunState>) =>
    toWireLedger(escalationLedgerOf(run, { operation: 'fill-combobox', family: 'combobox' }));

  it('names each query form it asked, and why it was allowed to ask it', async () => {
    // FEAT-034 TASK-004's contract, finally true at runtime: the form is the
    // rung's entry evidence rather than a hand-built record whose `detail`
    // carried the typed text into the ledger.
    const base = WidgetTestPort.fromFixture('prefix-only-matcher.html');
    const field = target(base, '#q', 'combobox', 'Where to?');
    const run = runFor(base);

    const outcome = await fillField(
      base,
      { field: 'Where to?', target: field },
      { kind: 'text', text: 'San Jose Mineta International Airport (SJC)' },
      { deadlineMs: base.now() + 20_000, maxActions: 32, maxPagingSteps: 12, run },
    );

    expect(outcome).toMatchObject({ ok: true });
    const forms = wireOf(run).filter(
      (record) => typeof record.strategy === 'string' && record.strategy.startsWith('query:'),
    );
    expect(forms.map((record) => [record.strategy, record.axis])).toEqual([
      ['query:as-given', 'what'],
      ['query:code-token', 'what'],
      ['query:prefix-retreat', 'what'],
    ]);
    expect(forms[0]!.entry_evidence).toEqual(['query:as-given']);
    expect(forms[1]!.entry_evidence).toEqual(['query:code-token', 'previous-form-no-suggestions']);
    expect(forms[2]!.entry_evidence).toEqual([
      'query:prefix-retreat',
      'previous-form-no-suggestions',
    ]);
    // The typed query text itself never rides the ledger. The form kind is the
    // structural token that replaced `detail: 'asked \"...\"'`.
    expect(JSON.stringify(forms)).not.toContain('asked "');
  }, 30_000);

  it('skips the later forms when the first one already offered candidates', async () => {
    const port = alwaysOffers('Dallas Fort Worth International Airport (DFW)');
    const field = target(port, '#q', 'combobox', 'Where from?');
    const run = runFor(port);

    const outcome = await fillField(
      port,
      { field: 'Where from?', target: field },
      { kind: 'text', text: 'Dallas Fort Worth International Airport (DFW)' },
      { deadlineMs: port.now() + 20_000, maxActions: 32, maxPagingSteps: 12, run },
    );

    expect(outcome).toMatchObject({ ok: true });
    const forms = wireOf(run).filter(
      (record) => typeof record.strategy === 'string' && record.strategy.startsWith('query:'),
    );
    expect(forms.map((record) => [record.strategy, record.verdict])).toEqual([
      ['query:as-given', 'succeeded'],
      ['query:code-token', 'skipped'],
      ['query:prefix-retreat', 'skipped'],
    ]);
    for (const skipped of forms.slice(1)) {
      expect(skipped.unmet).toBe('previous-form-offered-candidates');
      expect(skipped).not.toHaveProperty('charged_actions');
    }
  }, 30_000);
});

/** A combobox that answers any keystroke with the same single suggestion. */
function alwaysOffers(label: string): WidgetTestPort {
  const port = new WidgetTestPort(
    '<input id="q" role="combobox" aria-label="Where from?" aria-autocomplete="list" ' +
      'aria-controls="opts" aria-expanded="false">' +
      '<div id="opts" role="listbox" style="display:none">' +
      `<button role="option">${label}</button></div>`,
  );
  const input = port.document.querySelector('#q') as HTMLInputElement;
  const popup = port.document.querySelector('#opts') as HTMLElement;
  input.addEventListener('input', () => {
    popup.style.display = 'block';
    input.setAttribute('aria-expanded', 'true');
  });
  popup.querySelector('button')!.addEventListener('click', () => {
    input.value = label;
    popup.style.display = 'none';
    input.setAttribute('aria-expanded', 'false');
  });
  port.document.addEventListener('keydown', (event) => {
    if ((event as KeyboardEvent).key === 'Escape') {
      popup.style.display = 'none';
      input.setAttribute('aria-expanded', 'false');
    }
  });
  return port;
}
