import { describe, expect, it } from 'vitest';

import {
  dismissWidget,
  fillField,
  parseFillValue,
  watchAndSelect,
  type WidgetTarget,
} from '../../src/index.js';
import { CalendarTestPort } from '../widgets/calendar-test-port.js';

const budget = (port: CalendarTestPort) => ({
  deadlineMs: port.now() + 10_000,
  maxActions: 8,
});

function target(
  port: CalendarTestPort,
  selector: string,
  role: string,
  name: string,
): WidgetTarget {
  return { ref: port.refFor(selector), role, name, group: null, value: null };
}

describe('@no-llm unified fill intent parsing', () => {
  it.each([
    ['2026-02-29', 'textbox'],
    ['2026-13-04', 'textbox'],
    ['2026-08-10..2026-08-01', 'textbox'],
    ['2026-08-01..not-a-date', 'textbox'],
  ])('rejects malformed date-shaped value %s', (value, role) => {
    expect(parseFillValue(value, role)).toMatchObject({
      ok: false,
      errorCode: 'FILL_VALUE_INVALID',
    });
  });

  it('recognises date ranges, toggle vocabulary, and option controls', () => {
    expect(parseFillValue('2026-08-21..2026-08-22', 'textbox')).toEqual({
      kind: 'date_range',
      from: '2026-08-21',
      to: '2026-08-22',
    });
    expect(parseFillValue('checked', 'checkbox')).toEqual({ kind: 'toggle', checked: true });
    expect(parseFillValue('Economy', 'combobox')).toEqual({ kind: 'option', value: 'Economy' });
  });

  it('rejects credential-shaped literals before they reach the DOM', () => {
    expect(parseFillValue(`sk-${'a'.repeat(20)}`, 'textbox')).toMatchObject({
      ok: false,
      errorCode: 'FILL_VALUE_INVALID',
    });
  });
});

describe('@no-llm unified fill engine routing', () => {
  it.each([
    ['MM/DD/YYYY', '08/21/2026'],
    ['DD/MM/YYYY', '21/08/2026'],
  ])('formats a text date input from its %s hint', async (placeholder, committed) => {
    const port = new CalendarTestPort(
      `<input id="date" aria-label="Check-in" placeholder="${placeholder}">`,
    );
    const field = target(port, '#date', 'textbox', 'Check-in');

    const outcome = await fillField(
      port,
      { field: 'Check-in', target: field },
      { kind: 'date', date: '2026-08-21' },
      budget(port),
    );

    expect(outcome).toMatchObject({ ok: true, driver: 'date-input', committed });
  });

  it('fills a date range into the uniquely named check-in and check-out pair', async () => {
    const port = new CalendarTestPort(
      '<input id="from" aria-label="Check-in" placeholder="MM/DD/YYYY">' +
        '<input id="to" aria-label="Check-out" placeholder="MM/DD/YYYY">',
    );
    const field = target(port, '#from', 'textbox', 'Check-in');

    const outcome = await fillField(
      port,
      { field: 'Check-in', target: field },
      { kind: 'date_range', from: '2026-08-21', to: '2026-08-22' },
      budget(port),
    );

    expect(outcome).toMatchObject({
      ok: true,
      driver: 'date-input-range',
      committed: '08/21/2026..08/22/2026',
    });
    expect((port.document.querySelector('#from') as HTMLInputElement).value).toBe('08/21/2026');
    expect((port.document.querySelector('#to') as HTMLInputElement).value).toBe('08/22/2026');
  });

  it('routes native selects and verifies the committed option', async () => {
    const port = new CalendarTestPort(
      '<select aria-label="Cabin"><option value="coach">Economy</option><option>Business</option></select>',
    );
    const field = target(port, 'select', 'combobox', 'Cabin');

    const outcome = await fillField(
      port,
      { field: 'Cabin', target: field },
      { kind: 'option', value: 'Business' },
      budget(port),
    );

    expect(outcome).toMatchObject({ ok: true, driver: 'native-select', committed: 'Business' });
  });

  it('changes a toggle only when its committed state differs', async () => {
    const port = new CalendarTestPort('<input type="checkbox" aria-label="Refundable">');
    const field = target(port, 'input', 'checkbox', 'Refundable');
    const input = port.document.querySelector<HTMLInputElement>('input')!;
    input.addEventListener('click', () => {
      input.checked = true;
    });

    const first = await fillField(
      port,
      { field: 'Refundable', target: field },
      { kind: 'toggle', checked: true },
      budget(port),
    );
    const second = await fillField(
      port,
      { field: 'Refundable', target: field },
      { kind: 'toggle', checked: true },
      budget(port),
    );

    expect(first).toMatchObject({ ok: true, driver: 'toggle', actions: 1 });
    expect(second).toMatchObject({ ok: true, driver: 'toggle', actions: 0 });
  });

  it('opens and selects from a non-editable listbox without a detection registry', async () => {
    const port = new CalendarTestPort(
      '<button id="cabin" role="combobox" aria-label="Cabin" aria-controls="options" aria-expanded="false"></button>' +
        '<div id="options" role="listbox" style="display:none"><button role="option">Economy</button><button role="option">Business</button></div>',
    );
    const trigger = port.document.querySelector<HTMLElement>('#cabin')!;
    const popup = port.document.querySelector<HTMLElement>('#options')!;
    trigger.addEventListener('click', () => {
      popup.style.display = 'block';
      trigger.setAttribute('aria-expanded', 'true');
    });
    popup.querySelectorAll('button').forEach((option) => {
      option.addEventListener('click', () => {
        trigger.setAttribute('aria-label', `Cabin, ${option.textContent}`);
        popup.style.display = 'none';
        trigger.setAttribute('aria-expanded', 'false');
      });
    });
    const field = target(port, '#cabin', 'combobox', 'Cabin');

    const outcome = await fillField(
      port,
      { field: 'Cabin', target: field },
      { kind: 'option', value: 'Business' },
      budget(port),
    );

    expect(outcome).toMatchObject({ ok: true, driver: 'listbox', committed: 'Cabin, Business' });
  });
});

describe('@no-llm reactive suggestion handling', () => {
  it('selects the unique best suggestion that appears only after typing', async () => {
    const port = suggestionPort(['Dallas (DFW)', 'Denver (DEN)']);
    const field = target(port, '#airport', 'textbox', 'Going to');

    const outcome = await fillField(
      port,
      { field: 'Going to', target: field },
      { kind: 'text', text: 'Dallas' },
      budget(port),
    );

    expect(outcome).toMatchObject({ ok: true, driver: 'typeahead', dismissed: true });
    expect((port.document.querySelector('#airport') as HTMLInputElement).value).toBe(
      'Dallas (DFW)',
    );
  });

  it.each([
    ['a text intent', { kind: 'text', text: 'New York' } as const],
    ['an option intent on an editable control', { kind: 'option', value: 'New York' } as const],
  ])('keeps the typed literal when suggestions tie for %s', async (_label, intent) => {
    const port = suggestionPort(['New York, NY', 'New York, USA']);
    const field = target(port, '#airport', 'textbox', 'Going to');

    const outcome = await fillField(
      port,
      { field: 'Going to', target: field },
      intent,
      budget(port),
    );

    // An editable control is a search box, not a menu: the typed characters are
    // already a correct commit, so an unresolvable suggestion list is released
    // instead of discarding the fill. Picking one of the tied names would be
    // the guess this engine refuses to make — the run this covers failed the
    // whole call here on Google's combobox, which offered seven equal prefixes.
    expect(outcome).toMatchObject({ ok: true, driver: 'plain-text' });
    expect((port.document.querySelector('#airport') as HTMLInputElement).value).toBe('New York');
  });

  it('still refuses to guess on a control that cannot hold typed text', async () => {
    const port = new CalendarTestPort(
      '<div id="cabin" role="combobox" aria-controls="opts" aria-expanded="true">Cabin</div>' +
        '<div id="opts" role="listbox">' +
        '<div role="option">Business Flex</div><div role="option">Business Saver</div></div>',
    );
    const field = target(port, '#cabin', 'combobox', 'Cabin');

    const outcome = await fillField(
      port,
      { field: 'Cabin', target: field },
      { kind: 'option', value: 'Business' },
      budget(port),
    );

    expect(outcome).toMatchObject({
      ok: false,
      errorCode: 'WIDGET_AMBIGUOUS_CHOICE',
      details: { offered: ['Business Flex', 'Business Saver'] },
    });
  });

  it('dismisses unmatched suggestions and preserves the typed literal', async () => {
    const port = suggestionPort(['Dallas', 'Denver']);
    const field = target(port, '#airport', 'textbox', 'Going to');

    await port.fill(field.ref, 'Zurich');
    const outcome = await watchAndSelect(port, field, 'Zurich', budget(port));

    expect(outcome).toMatchObject({ ok: true, selected: false, dismissed: true });
    expect((port.document.querySelector('#airport') as HTMLInputElement).value).toBe('Zurich');
  });

  it('commits literal text when no popup appears within the bounded watch', async () => {
    let clock = 0;
    const port = new CalendarTestPort('<input id="note" aria-label="Note">', () => {
      clock += 2_000;
      return clock;
    });
    const field = target(port, '#note', 'textbox', 'Note');

    await port.fill(field.ref, 'quiet room');
    const outcome = await watchAndSelect(port, field, 'quiet room', {
      deadlineMs: 100_000,
      maxActions: 8,
    });

    expect(outcome).toMatchObject({
      ok: true,
      committed: 'quiet room',
      selected: false,
      dismissed: false,
    });
  });
});

describe('@no-llm commit-and-dismiss lifecycle', () => {
  it('prefers one visible commit control and verifies that the value survives', async () => {
    const port = new CalendarTestPort(
      '<input id="dates" aria-label="Dates" aria-controls="picker" value="2026-08-21">' +
        '<div id="picker" role="dialog"><button>Done</button></div>',
    );
    const field = target(port, '#dates', 'textbox', 'Dates');
    const popup = port.document.querySelector<HTMLElement>('#picker')!;
    popup.querySelector('button')!.addEventListener('click', () => {
      popup.style.display = 'none';
    });

    const outcome = await dismissWidget(port, field, '2026-08-21', (value) =>
      value.includes('2026-08-21'),
    );

    expect(outcome).toMatchObject({ ok: true, dismissed: true, committed: '2026-08-21' });
  });

  it('reports a typed dismissal failure when Escape reverts the value', async () => {
    let clock = 0;
    const port = new CalendarTestPort(
      '<input id="dates" aria-label="Dates" aria-controls="picker" value="2026-08-21">' +
        '<div id="picker" role="dialog"><button>21</button><button>22</button></div>',
      () => {
        clock += 4_000;
        return clock;
      },
    );
    const input = port.document.querySelector<HTMLInputElement>('#dates')!;
    const popup = port.document.querySelector<HTMLElement>('#picker')!;
    port.document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        input.value = '';
        popup.style.display = 'none';
      }
    });
    const field = target(port, '#dates', 'textbox', 'Dates');

    const outcome = await dismissWidget(port, field, '2026-08-21', (value) =>
      value.includes('2026-08-21'),
    );

    expect(outcome).toMatchObject({ ok: false, errorCode: 'WIDGET_DISMISS_FAILED' });
  });
});

describe('@no-llm fill engine recovery', () => {
  it('completes a fill when opening the widget replaces the trigger and clones it', async () => {
    const port = remountingCalendarPort();
    const field = target(port, '#ci', 'textbox', 'Check-in');

    const outcome = await fillField(
      port,
      { field: 'Check-in', target: field },
      { kind: 'date', date: '2026-09-06' },
      budget(port),
    );

    // Opening re-mounts the trigger *and* mounts a second control with the same
    // name inside the popup. Re-acquisition used to refuse that as ambiguous
    // and abandon the drive on the first click, every time, on any site built
    // this way.
    expect(outcome).toMatchObject({ ok: true });
    expect(port.clickLog.map((entry) => entry.name)).toContain('6');
  });

  it('re-tests a disabled range start against a freshly reopened picker', async () => {
    const port = remountingCalendarPort({ startsDisabled: true });
    const field = target(port, '#ci', 'textbox', 'Check-in');

    const outcome = await fillField(
      port,
      { field: 'Check-in', target: field },
      { kind: 'date_range', from: '2026-09-06', to: '2026-09-08' },
      budget(port),
    );

    // A picker left mid-selection greys out everything before the start it is
    // waiting to pair, so "disabled" can describe the widget's state rather
    // than the date. Reopening clears that, and only then is the claim final.
    expect(outcome).toMatchObject({ ok: true });
    // The reopen costs one extra trigger click; what matters is that both
    // endpoints then landed, in order.
    expect(port.clickLog.map((entry) => entry.name).filter((name) => /^\d+$/.test(name))).toEqual([
      '6',
      '8',
    ]);
  });

  it('reports a genuinely unavailable date after the reopen has been tried', async () => {
    const port = remountingCalendarPort({ startsDisabled: true, staysDisabled: true });
    const field = target(port, '#ci', 'textbox', 'Check-in');

    const outcome = await fillField(
      port,
      { field: 'Check-in', target: field },
      { kind: 'date_range', from: '2026-09-06', to: '2026-09-08' },
      budget(port),
    );

    expect(outcome).toMatchObject({
      ok: false,
      errorCode: 'WIDGET_TARGET_UNREACHABLE',
      details: { reason: 'disabled' },
    });
    expect(port.clickLog.map((entry) => entry.name)).not.toContain('6');
  });

  it('waits for a paired range whose second field is written after release', async () => {
    const port = new CalendarTestPort(
      '<input id="ci" aria-label="Check-in" aria-controls="cal" value="Aug 10">' +
        '<input id="co" aria-label="Check-out" value="Aug 11">' +
        '<div id="cal" role="dialog"><table><caption>September 2026</caption><tbody><tr>' +
        '<td><button data-date="2026-09-06">6</button></td>' +
        '<td><button data-date="2026-09-08">8</button></td></tr></tbody></table></div>',
    );
    const checkIn = port.document.querySelector<HTMLInputElement>('#ci')!;
    const checkOut = port.document.querySelector<HTMLInputElement>('#co')!;
    const cells = port.document.querySelectorAll<HTMLElement>('#cal button');
    cells[0]!.addEventListener('click', () => {
      checkIn.value = 'Sep 6';
    });
    // The page writes the far side of the range a beat later, as real pickers
    // do while they settle. Reading once races that and calls a landed range
    // uncommitted.
    cells[1]!.addEventListener('click', () => {
      setTimeout(() => {
        checkOut.value = 'Sep 8';
      }, 250);
    });
    const popup = port.document.querySelector<HTMLElement>('#cal')!;
    port.document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') popup.style.display = 'none';
    });
    const field = target(port, '#ci', 'textbox', 'Check-in');

    const outcome = await fillField(
      port,
      { field: 'Check-in', target: field },
      { kind: 'date_range', from: '2026-09-06', to: '2026-09-08' },
      { deadlineMs: port.now() + 10_000, maxActions: 8, maxPagingSteps: 12 },
    );

    expect(outcome).toMatchObject({ ok: true, committed: 'Sep 6..Sep 8' });
  });

  it('carries a next step on both rejected input and a widget that would not commit', async () => {
    // A typed code says what happened; without a next step the caller tends to
    // abandon the tool and drive the widget by hand, which is the behaviour
    // these tools exist to replace.
    const rejected = parseFillValue('2026-02-31', 'textbox');
    expect((rejected as { details: { hint?: string } }).details.hint).toMatch(/YYYY-MM-DD/);

    const port = new CalendarTestPort(
      '<input id="d" aria-label="Check-in" placeholder="YYYY-MM-DD">',
    );
    const rejecting = port.document.querySelector<HTMLInputElement>('#d')!;
    rejecting.addEventListener('input', () => {
      rejecting.value = '';
    });
    const field = target(port, '#d', 'textbox', 'Check-in');
    const outcome = await fillField(
      port,
      { field: 'Check-in', target: field },
      { kind: 'date', date: '2026-09-06' },
      budget(port),
    );

    expect(outcome).toMatchObject({ ok: false });
    expect((outcome as { details: { hint?: string } }).details.hint).toMatch(/re-observe/i);
  });
});

/**
 * A calendar that re-mounts its trigger on open and clones it into the popup —
 * the single-page shape that defeated re-acquisition on the real page.
 */
function remountingCalendarPort(
  options: { readonly startsDisabled?: boolean; readonly staysDisabled?: boolean } = {},
): CalendarTestPort {
  const cell = (day: number, disabled: boolean): string =>
    `<td><button data-date="2026-09-0${day}"${disabled ? ' aria-disabled="true"' : ''}>${day}</button></td>`;
  const port = new CalendarTestPort(
    '<div id="host"><input id="ci" aria-label="Check-in" aria-controls="cal" value="Aug 10"></div>' +
      '<div id="cal" role="dialog" style="display:none">' +
      '<input aria-label="Check-in" value="Aug 10">' +
      `<table><caption>September 2026</caption><tbody><tr>${cell(6, options.startsDisabled === true)}${cell(8, false)}</tr></tbody></table>` +
      '</div>',
  );
  const popup = port.document.querySelector<HTMLElement>('#cal')!;
  const open = (): void => {
    popup.style.display = 'block';
    const previous = port.document.querySelector<HTMLElement>('#ci')!;
    previous.replaceWith(previous.cloneNode(true));
    bind();
  };
  const bind = (): void => {
    port.document
      .querySelector<HTMLElement>('#ci')!
      .addEventListener('click', open, { once: true });
  };
  port.document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    popup.style.display = 'none';
    if (options.staysDisabled === true) return;
    // Reopening reverts the picker to its committed pair, which is what frees
    // a date the pending half-selection had greyed out.
    for (const button of popup.querySelectorAll('button')) button.removeAttribute('aria-disabled');
  });
  for (const button of popup.querySelectorAll('button')) {
    button.addEventListener('click', () => {
      const input = port.document.querySelector<HTMLInputElement>('#ci')!;
      const day = button.textContent ?? '';
      input.value = input.value.startsWith('Sep') ? `${input.value} - Sep ${day}` : `Sep ${day}`;
    });
  }
  bind();
  return port;
}

function suggestionPort(options: readonly string[]): CalendarTestPort {
  const port = new CalendarTestPort(
    '<input id="airport" aria-label="Going to" aria-controls="suggestions">' +
      `<div id="suggestions" role="listbox" style="display:none">${options
        .map((option) => `<button role="option">${option}</button>`)
        .join('')}</div>`,
  );
  const input = port.document.querySelector<HTMLInputElement>('#airport')!;
  const popup = port.document.querySelector<HTMLElement>('#suggestions')!;
  input.addEventListener('input', () => {
    popup.style.display = 'block';
  });
  popup.querySelectorAll('button').forEach((option) => {
    option.addEventListener('click', () => {
      input.value = option.textContent ?? '';
      popup.style.display = 'none';
    });
  });
  port.document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') popup.style.display = 'none';
  });
  return port;
}
