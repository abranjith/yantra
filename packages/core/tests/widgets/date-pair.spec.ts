import { describe, expect, it } from 'vitest';

import { resolveDatePair, type WidgetTarget } from '../../src/index.js';
import { WidgetTestPort } from '../support/widget-test-port.js';

const target = (ref: string, name: string, role = 'button'): WidgetTarget => ({
  ref,
  role,
  name,
  group: null,
  value: null,
});

describe('@no-llm date field pair resolution', () => {
  it('pairs two button triggers, which is what a compact picker uses', async () => {
    // KAYAK's ends are `div[role=button]`, not text boxes. Excluding the role
    // meant every paired range on such a site was driven as a lone date: the
    // engine never re-pointed the drive at the opening end, and the check-in
    // half of a landed selection read as uncommitted.
    const port = new WidgetTestPort(
      '<div id="from" role="button" aria-label="Select start date from calendar input">Sun 9/6</div>' +
        '<div id="to" role="button" aria-label="Select end date from calendar input">Sat 9/12</div>',
    );

    const pair = await resolveDatePair(port, target('e1', 'Select start date from calendar input'));

    expect(pair?.from.name).toBe('Select start date from calendar input');
    expect(pair?.to.name).toBe('Select end date from calendar input');
  });

  it('still pairs text inputs', async () => {
    const port = new WidgetTestPort(
      '<input id="from" aria-label="Check-in"><input id="to" aria-label="Check-out">',
    );

    const pair = await resolveDatePair(port, target('e1', 'Check-in', 'textbox'));

    expect(pair?.from.name).toBe('Check-in');
    expect(pair?.to.name).toBe('Check-out');
  });

  it('never mistakes a selected day cell for the field that opened the calendar', async () => {
    // An open picker labels its chosen days "Selected as start date", which
    // reads as a range end to any name test and is a `button` like the trigger.
    // Taken as the pair, the engine re-points the whole drive at a day cell,
    // which opens nothing — the WIDGET_DID_NOT_OPEN cascade in run
    // 20260812T025402Z-do-7af96d55.
    const port = new WidgetTestPort(
      '<div id="from" role="button" aria-label="Select start date from calendar input">Sun 9/6</div>' +
        '<div id="to" role="button" aria-label="Select end date from calendar input">Sat 9/12</div>' +
        '<table role="grid"><caption>September 2026</caption><tr>' +
        '<td><button aria-label="September 6, 2026. Selected as start date">6</button></td>' +
        '<td><button aria-label="September 12, 2026. Selected as end date">12</button></td>' +
        '</tr></table>',
    );

    const pair = await resolveDatePair(port, target('e1', 'Select start date from calendar input'));

    expect(pair?.from.name).toBe('Select start date from calendar input');
    expect(pair?.to.name).toBe('Select end date from calendar input');
  });

  it('refuses a page offering two candidates for the same side', async () => {
    const port = new WidgetTestPort(
      '<div id="a" role="button" aria-label="Check-in">1</div>' +
        '<div id="b" role="button" aria-label="Room 2 check-in">2</div>' +
        '<div id="c" role="button" aria-label="Check-out">3</div>',
    );

    await expect(resolveDatePair(port, target('e1', 'Check-in'))).resolves.toBeNull();
  });

  it('refuses when the only candidates are inside the grid', async () => {
    // Nothing outside the calendar names a side, so there is no field pair to
    // read — and guessing at the cells is the failure this guards.
    const port = new WidgetTestPort(
      '<table role="grid"><caption>September 2026</caption><tr>' +
        '<td><button aria-label="September 6, 2026. Selected as start date">6</button></td>' +
        '<td><button aria-label="September 12, 2026. Selected as end date">12</button></td>' +
        '</tr></table>',
    );

    await expect(
      resolveDatePair(port, target('e1', 'September 6, 2026. Selected as start date')),
    ).resolves.toBeNull();
  });
});
