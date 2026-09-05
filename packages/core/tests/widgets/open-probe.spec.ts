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
    // The probe returns no ledger of its own any more; the `open-probe` rung
    // that ran it is the record, on the caller's one sequence.
    expect(probed).not.toHaveProperty('ledger');
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

describe('@no-llm the probe drives what it revealed as a sub-plan', () => {
  it('leaves one continuous sequence with the drive and the probe as separate verdicts', async () => {
    // The defect this replaced: `driveFamilyPlan` spliced a driver-local ledger
    // in after its owning rung and renumbered, producing two records describing
    // the same window at two nesting levels, presented as a sequence.
    const port = WidgetTestPort.fromFixture('click-to-reveal-calendar.html');
    const field = target(port, '#trigger', 'textbox', 'Departure');
    const run = createRunState(
      { deadlineMs: port.now() + 20_000, maxActions: 32, maxReacquisitions: 4 },
      port.now(),
    );

    const outcome = await fillField(
      port,
      { field: 'Departure', target: field },
      { kind: 'date', date: '2026-12-02' },
      { deadlineMs: port.now() + 20_000, maxActions: 32, maxPagingSteps: 12, run },
    );

    expect(outcome).toMatchObject({ ok: true, driver: 'calendar-grid' });
    const wire = toWireLedger(escalationLedgerOf(run, { operation: 'fill-date', family: 'date' }));
    const performed = wire.filter((record) => record.verdict !== 'skipped');
    // Completion order. The nested drive finishes inside the probe rung, so it
    // lands first; the probe rung's own verdict closes over it.
    expect(performed.map((record) => record.strategy)).toEqual([
      'driver:calendar-grid',
      'open-probe',
    ]);
    // Continuous, runner-assigned, never renumbered afterwards.
    expect(wire.map((record) => record.ordinal)).toEqual(wire.map((_r, index) => index + 1));
    // The registry kind, not page text.
    expect(performed.find((record) => record.strategy === 'open-probe')?.revealed_driver).toBe(
      'calendar-grid',
    );
    // Paging is choreography, not escalation: it contributes no verdict.
    expect(performed.map((record) => record.strategy)).not.toContain('page-month');
  }, 30_000);

  it('dismisses exactly once when nothing recognised the container, and never when skipped', async () => {
    const opens = new WidgetTestPort(
      '<input id="trigger" aria-label="Departure">' +
        '<div id="panel" role="dialog" style="display:none"><p>nothing here</p></div>',
    );
    const trigger = opens.document.querySelector('#trigger')!;
    const panel = opens.document.querySelector('#panel') as HTMLElement;
    trigger.addEventListener('click', () => {
      panel.style.display = 'block';
    });
    let escapes = 0;
    opens.document.addEventListener('keydown', (event) => {
      if ((event as KeyboardEvent).key === 'Escape') {
        escapes += 1;
        panel.style.display = 'none';
      }
    });
    const field = target(opens, '#trigger', 'textbox', 'Departure');

    const unrecognized = await probeOpen(opens, field, 'date', budget(opens), {
      intent: { kind: 'date', date: '2026-12-02' },
      detect,
      detectOpen: async () => [],
      drive: async () => {
        throw new Error('nothing should have been driven');
      },
    });

    expect(unrecognized.kind).toBe('unrecognized');
    expect(escapes).toBe(1);

    const search = new WidgetTestPort('<input id="q" aria-label="Search">');
    const skipped = await probeOpen(
      search,
      target(search, '#q', 'textbox', 'Search'),
      'option',
      budget(search),
      {
        intent: { kind: 'option', value: 'Economy' },
        detect,
        detectOpen: async () => [],
        drive: async () => {
          throw new Error('nothing should have been driven');
        },
      },
    );

    expect(skipped).toEqual({ kind: 'skipped', reason: 'semantics-disagree' });
    expect(escapes).toBe(1);
  }, 30_000);

  it('surfaces the ledger unconditionally when it opened and nothing recognised it', async () => {
    // Wave 1's deliberate exception to the "report the ledger only when it says
    // something" rule: one probe and one failure is still worth reporting,
    // because "it opened, and no driver understood it" is the whole answer.
    const port = new WidgetTestPort(
      '<input id="trigger" aria-label="Departure">' +
        '<div id="panel" role="dialog" style="display:none"><p>nothing here</p></div>',
    );
    const trigger = port.document.querySelector('#trigger')!;
    const panel = port.document.querySelector('#panel') as HTMLElement;
    trigger.addEventListener('click', () => {
      panel.style.display = 'block';
    });
    port.document.addEventListener('keydown', (event) => {
      if ((event as KeyboardEvent).key === 'Escape') panel.style.display = 'none';
    });

    const outcome = await fillField(
      port,
      { field: 'Departure', target: target(port, '#trigger', 'textbox', 'Departure') },
      { kind: 'date', date: '2026-12-02' },
      budget(port),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(attemptsOf(outcome).map((record) => record.strategy)).toContain('open-probe');
  }, 30_000);
});
