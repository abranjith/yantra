/**
 * The engine-owned open stage.
 *
 * Two properties are being protected, and they fail differently: the probe must
 * reach a picker that closed-state detection cannot see, and it must not run
 * anywhere else — a probe that fires freely is a click on a control nobody
 * asked to open.
 */

import { describe, expect, it } from 'vitest';

import {
  createDefaultWidgetRegistry,
  fillField,
  probeOpen,
  shouldProbeOpen,
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
  const success = outcome as { readonly attempted?: readonly AttemptRecord[] };
  const failure = outcome as {
    readonly details?: { readonly attempted?: readonly AttemptRecord[] };
  };
  return success.attempted ?? failure.details?.attempted ?? [];
}

/** A port that counts clicks, so "did the probe run" is a fact not an inference. */
function clickCounting(port: WidgetTestPort): { readonly port: WidgetPort; clicks: () => number } {
  let clicks = 0;
  return {
    port: {
      observe: (options) => port.observe(options),
      click: async (ref) => {
        clicks += 1;
        return port.click(ref);
      },
      fill: (ref, value) => port.fill(ref, value),
      clear: (ref) => port.clear(ref),
      type: (ref, text, options) => port.type(ref, text, options),
      evaluateOn: (ref, fn, ...args) => port.evaluateOn(ref, fn, ...args),
      evaluate: (fn, ...args) => port.evaluate(fn, ...args),
      press: (key) => port.press(key),
      now: () => port.now(),
    },
    clicks: () => clicks,
  };
}

const registry = createDefaultWidgetRegistry();
const detect = registry.detectDrivers.bind(registry);

describe('@no-llm open-probe entry condition', () => {
  it('agrees to probe a bare textbox asked for a date', async () => {
    const port = WidgetTestPort.fromFixture('click-to-reveal-calendar.html');

    expect(
      await shouldProbeOpen(port, target(port, '#trigger', 'textbox', 'Departure'), {
        kind: 'date',
        date: '2026-12-02',
      }),
    ).toBe(true);
  });

  it('refuses to probe a plain text box asked for an option', async () => {
    // A text box asked for an option is a text box. Clicking it would achieve
    // nothing but a click.
    const port = new WidgetTestPort('<input id="q" aria-label="Search">');

    expect(
      await shouldProbeOpen(port, target(port, '#q', 'textbox', 'Search'), {
        kind: 'option',
        value: 'Economy',
      }),
    ).toBe(false);
  });

  it('agrees to probe a control that declares it opens something', async () => {
    const port = new WidgetTestPort(
      '<button id="t" aria-label="Cabin" aria-haspopup="listbox">Cabin</button>',
    );

    expect(
      await shouldProbeOpen(port, target(port, '#t', 'button', 'Cabin'), {
        kind: 'option',
        value: 'Business',
      }),
    ).toBe(true);
  });
});

describe('@no-llm open-probe stage', () => {
  it('reaches a calendar that only exists after a click, in one fill', async () => {
    // The run's seq 30 and 58, and the eleven hand-driven browser_click calls
    // between them.
    const port = WidgetTestPort.fromFixture('click-to-reveal-calendar.html');
    const field = target(port, '#trigger', 'textbox', 'Departure');

    const outcome = await fillField(
      port,
      { field: 'Departure', target: field },
      { kind: 'date', date: '2026-12-02' },
      budget(port),
    );

    expect(outcome).toMatchObject({ ok: true, driver: 'calendar-grid' });
    expect(attemptsOf(outcome).map((record) => record.strategy)).toContain('open-probe');
    expect(port.document.querySelector<HTMLInputElement>('#trigger')!.value).toBe('Dec 2, 2026');
  }, 30_000);

  it('dismisses what it opened and reports what it saw when nothing opens', async () => {
    const port = new WidgetTestPort('<input id="trigger" aria-label="Departure">');
    const field = target(port, '#trigger', 'textbox', 'Departure');

    const probed = await probeOpen(port, field, 'date', budget(port), {
      intent: { kind: 'date', date: '2026-12-02' },
      detect,
    });

    expect(probed.kind).toBe('unrecognized');
    if (probed.kind !== 'unrecognized') return;
    expect(probed.failure.details).toMatchObject({ containerResolved: false, cellsSeen: 0 });
    expect(probed.ledger.records[0]).toMatchObject({ strategy: 'open-probe', axis: 'how' });
  }, 30_000);

  it('does not run when a driver already detected the control', async () => {
    // Asserted by click count: the readonly date trigger is recognised from its
    // closed state, so the calendar driver's own single open is the only click
    // this fill should make on the trigger.
    const base = WidgetTestPort.fromFixture('readonly-date-trigger.html');
    const counted = clickCounting(base);
    const field = target(base, '#trigger', 'textbox', 'Choose date');

    const outcome = await fillField(
      counted.port,
      { field: 'Choose date', target: field },
      { kind: 'date', date: '2026-12-02' },
      budget(base),
    );

    expect(outcome.ok).toBe(true);
    expect(attemptsOf(outcome).map((record) => record.strategy)).not.toContain('open-probe');
  }, 30_000);

  it('does not run when the field semantics disagree with the intent', async () => {
    const base = new WidgetTestPort('<input id="q" aria-label="Search">');
    const counted = clickCounting(base);
    const field = target(base, '#q', 'textbox', 'Search');

    const probed = await probeOpen(counted.port, field, 'option', budget(base), {
      intent: { kind: 'option', value: 'Economy' },
      detect,
    });

    expect(probed).toEqual({ kind: 'skipped', reason: 'semantics-disagree' });
    expect(counted.clicks()).toBe(0);
  });

  it('refuses before clicking when the budget is already spent', async () => {
    const base = WidgetTestPort.fromFixture('click-to-reveal-calendar.html');
    const counted = clickCounting(base);
    const field = target(base, '#trigger', 'textbox', 'Departure');

    const probed = await probeOpen(
      counted.port,
      field,
      'date',
      { ...budget(base), maxActions: 1 },
      {
        intent: { kind: 'date', date: '2026-12-02' },
        detect,
      },
    );

    expect(probed).toEqual({ kind: 'skipped', reason: 'budget' });
    expect(counted.clicks()).toBe(0);
  });

  it('probes at most once within one fill', async () => {
    // The probe is a click on a control the caller addressed; running it twice
    // would open, close and reopen a widget for no new information.
    const base = new WidgetTestPort('<input id="trigger" aria-label="Departure">');
    const counted = clickCounting(base);
    const field = target(base, '#trigger', 'textbox', 'Departure');

    const outcome = await fillField(
      counted.port,
      { field: 'Departure', target: field },
      { kind: 'date', date: '2026-12-02' },
      budget(base),
    );

    expect(outcome.ok).toBe(false);
    expect(attemptsOf(outcome).filter((record) => record.strategy === 'open-probe')).toHaveLength(
      1,
    );
    expect(counted.clicks()).toBe(1);
  }, 30_000);
});
