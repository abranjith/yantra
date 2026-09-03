import { describe, expect, it } from 'vitest';

import {
  dismissWidget,
  fillFailure,
  fillField,
  fillSecretField,
  parseFillValue,
  watchAndSelectOffered,
  type CauseFor,
  type WidgetTarget,
} from '../../src/index.js';
import { WidgetTestPort } from '../support/widget-test-port.js';

const budget = (port: WidgetTestPort) => ({
  deadlineMs: port.now() + 10_000,
  maxActions: 8,
});

/** A WIDGET_NOT_COMMITTED failure with one particular cause and observed state. */
function fillFailureFor(cause: CauseFor<'WIDGET_NOT_COMMITTED'>, details: Record<string, unknown>) {
  return fillFailure(
    'WIDGET_NOT_COMMITTED',
    cause,
    'The control did not commit the value.',
    details,
  );
}

function target(port: WidgetTestPort, selector: string, role: string, name: string): WidgetTarget {
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
    const port = new WidgetTestPort(
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
    const port = new WidgetTestPort(
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
    const port = new WidgetTestPort(
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
    const port = new WidgetTestPort('<input type="checkbox" aria-label="Refundable">');
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
    const port = new WidgetTestPort(
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

describe('@no-llm widget driver selection and fallback', () => {
  /** A read-only trigger showing a formatted date, opening a paged calendar. */
  function readOnlyDateTrigger(): WidgetTestPort {
    const port = new WidgetTestPort(
      '<input id="trigger" readonly aria-label="Choose date" aria-controls="cal" ' +
        'aria-expanded="false" value="Fri, Aug 28">' +
        '<div id="cal" role="dialog" style="display:none">' +
        '<button id="next" aria-label="Next month">›</button>' +
        '<table><caption>August 2026</caption><tbody><tr>' +
        '<td><button data-date="2026-08-28">28</button></td></tr></tbody></table></div>',
    );
    const trigger = port.document.querySelector<HTMLInputElement>('#trigger')!;
    const dialog = port.document.querySelector<HTMLElement>('#cal')!;
    const caption = port.document.querySelector<HTMLElement>('caption')!;
    const row = port.document.querySelector<HTMLElement>('tbody tr')!;
    const months = [
      'August 2026',
      'September 2026',
      'October 2026',
      'November 2026',
      'December 2026',
    ];
    let index = 0;
    const render = (): void => {
      caption.textContent = months[index]!;
      const month = String(index + 8).padStart(2, '0');
      row.innerHTML = `<td><button data-date="2026-${month}-02">2</button></td>`;
      for (const day of row.querySelectorAll('button')) {
        day.addEventListener('click', () => {
          trigger.value = `${months[index]!.slice(0, 3)} 2, 2026`;
          dialog.style.display = 'none';
          trigger.setAttribute('aria-expanded', 'false');
        });
      }
    };
    trigger.addEventListener('click', () => {
      dialog.style.display = 'block';
      trigger.setAttribute('aria-expanded', 'true');
      render();
    });
    port.document.querySelector('#next')!.addEventListener('click', () => {
      index = Math.min(index + 1, months.length - 1);
      render();
    });
    port.document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        dialog.style.display = 'none';
        trigger.setAttribute('aria-expanded', 'false');
      }
    });
    return port;
  }

  it('drives a read-only date trigger through the calendar, not by typing', async () => {
    // Run 20260827T045106Z-do-9a58de7e, seq 40. The accessible name contained
    // "date", so the driver that types into date inputs was chosen; it typed
    // into a control that cannot be typed into, failed, and stopped — while the
    // calendar that pages to December sat unconsulted. December was reported
    // unreachable for the rest of the run.
    const port = readOnlyDateTrigger();
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

  it('still prefers typing into a control that declares a date format', async () => {
    const port = new WidgetTestPort(
      '<input id="date" aria-label="Check-in" placeholder="MM/DD/YYYY">',
    );
    const field = target(port, '#date', 'textbox', 'Check-in');

    const outcome = await fillField(
      port,
      { field: 'Check-in', target: field },
      { kind: 'date', date: '2026-08-21' },
      budget(port),
    );

    expect(outcome).toMatchObject({ ok: true, driver: 'date-input' });
  });

  it('falls through to the calendar and names both drivers it tried', async () => {
    // A field that declares a typing format and does not honour it: it takes
    // the keystrokes and restores its own value. The typing driver is the
    // stronger candidate here — the format hint is a real signal — and it is
    // still wrong, which is exactly what the fallback exists for.
    const port = new WidgetTestPort(
      '<input id="d" aria-label="Depart" placeholder="MM/DD/YYYY" aria-controls="cal">' +
        '<div id="cal" role="dialog"><table><caption>August 2026</caption><tbody><tr>' +
        '<td><button data-date="2026-08-21">21</button></td>' +
        '</tr></tbody></table></div>',
    );
    const input = port.document.querySelector<HTMLInputElement>('#d')!;
    input.addEventListener('input', () => {
      input.value = '';
    });
    const dialog = port.document.querySelector<HTMLElement>('#cal')!;
    port.document.querySelector('#cal button')!.addEventListener('click', () => {
      // The picker writes the field programmatically, which is why the typing
      // path cannot reach it and the calendar can.
      input.value = '08/21/2026';
    });
    port.document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') dialog.style.display = 'none';
    });
    const field = target(port, '#d', 'textbox', 'Depart');

    const outcome = await fillField(
      port,
      { field: 'Depart', target: field },
      { kind: 'date', date: '2026-08-21' },
      budget(port),
    );

    expect(outcome).toMatchObject({ ok: true, driver: 'calendar-grid' });
    const attempted = (outcome.ok ? (outcome.attempted ?? []) : []) as {
      readonly strategy: string;
    }[];
    expect(attempted.map((record) => record.strategy)).toEqual([
      'driver:date-input',
      'driver:calendar-grid',
    ]);
  });

  it('reports no attempt ledger when only one driver was ever a candidate', async () => {
    const port = new WidgetTestPort(
      '<input id="date" aria-label="Check-in" placeholder="MM/DD/YYYY">',
    );
    const field = target(port, '#date', 'textbox', 'Check-in');

    const outcome = await fillField(
      port,
      { field: 'Check-in', target: field },
      { kind: 'date', date: '2026-08-21' },
      budget(port),
    );

    // One candidate, one attempt, nothing worth saying about it.
    expect(outcome).toMatchObject({ ok: true, driver: 'date-input' });
    expect(outcome.ok && outcome.attempted).toBeUndefined();
  });

  it('does not try a second driver against a definite answer', async () => {
    // A disabled day is the page saying no. Re-asking through another driver
    // spends the budget to hear the same thing twice.
    const port = new WidgetTestPort(
      '<button id="trigger" aria-label="Dates" aria-controls="cal" aria-expanded="true">Dates</button>' +
        '<div id="cal" role="dialog"><table><caption>August 2026</caption><tbody><tr>' +
        '<td><button data-date="2026-08-21" disabled>21</button></td>' +
        '</tr></tbody></table></div>',
    );
    const field = target(port, '#trigger', 'button', 'Dates');

    const outcome = await fillField(
      port,
      { field: 'Dates', target: field },
      { kind: 'date', date: '2026-08-21' },
      budget(port),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    const attempted = (outcome.details.attempted ?? []) as { readonly strategy: string }[];
    expect(attempted.length).toBeLessThanOrEqual(1);
  });
});

describe('@no-llm fill disclosure contract', () => {
  it('reports a code-to-label resolution as success naming both values', async () => {
    // THE motivating failure. Run 20260827T045106Z-do-9a58de7e, seq 10: the
    // engine typed "DFW", the suggestion carrying that code was clicked, and
    // the field settled on the short display name "Dallas" — which the
    // observation at seq 9 confirms. Verification compared that against the
    // *typed text*, so a fill that had landed came back as
    // WIDGET_NOT_COMMITTED and the agent spent the rest of its budget working
    // around a field that was already correct.
    const port = suggestionPort(['Dallas Fort Worth International Airport (DFW)'], 'Dallas');
    const field = target(port, '#airport', 'textbox', 'Where from?');

    const outcome = await fillField(
      port,
      { field: 'Where from?', target: field },
      { kind: 'text', text: 'DFW' },
      budget(port),
    );

    expect(outcome).toMatchObject({
      ok: true,
      driver: 'typeahead',
      requested: 'DFW',
      committed: 'Dallas',
      resolution: 'single_offered_match',
      offered: ['Dallas Fort Worth International Airport (DFW)'],
    });
    expect(outcome.ok && outcome.note).toContain('"DFW"');
    expect(outcome.ok && outcome.note).toContain('"Dallas"');
    expect(outcome.ok && outcome.note).toContain('not a failure');
  });

  it('distinguishes a choice among several offers from a lone match', async () => {
    const port = suggestionPort(['Dallas (DFW)', 'Denver (DEN)']);
    const field = target(port, '#airport', 'textbox', 'Where from?');

    const outcome = await fillField(
      port,
      { field: 'Where from?', target: field },
      { kind: 'text', text: 'Dallas' },
      budget(port),
    );

    expect(outcome).toMatchObject({
      ok: true,
      resolution: 'selected_from_offered',
      requested: 'Dallas',
      committed: 'Dallas (DFW)',
    });
    expect(outcome.ok && outcome.offered).toEqual(['Dallas (DFW)', 'Denver (DEN)']);
  });

  it('reports an unchanged value as exact and adds no note', async () => {
    const port = new WidgetTestPort('<input id="q" aria-label="Search">');
    const field = target(port, '#q', 'textbox', 'Search');

    const outcome = await fillField(
      port,
      { field: 'Search', target: field },
      { kind: 'text', text: 'winter coat' },
      budget(port),
    );

    expect(outcome).toMatchObject({
      ok: true,
      resolution: 'exact',
      requested: 'winter coat',
      committed: 'winter coat',
    });
    expect(outcome.ok && outcome.note).toBeUndefined();
  });

  it('reports a masked reformat as accepted rather than fought', async () => {
    const port = new WidgetTestPort('<input id="tel" aria-label="Phone">');
    const input = port.document.querySelector<HTMLInputElement>('#tel')!;
    input.addEventListener('input', () => {
      const digits = input.value.replace(/\D/g, '');
      if (digits.length === 10) {
        input.value = `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
      }
    });
    const field = target(port, '#tel', 'textbox', 'Phone');

    const outcome = await fillField(
      port,
      { field: 'Phone', target: field },
      { kind: 'text', text: '5551234567' },
      budget(port),
    );

    expect(outcome).toMatchObject({ ok: true, resolution: 'reformatted' });
    expect(outcome.ok && outcome.note).toContain('reformatted');
  });

  it('fails when a controlled input rewrites the request to unrelated text', async () => {
    const port = new WidgetTestPort('<input id="airport" aria-label="Airport">');
    const input = port.document.querySelector<HTMLInputElement>('#airport')!;
    input.addEventListener('input', () => {
      input.value = 'xyz';
    });
    const field = target(port, '#airport', 'textbox', 'Airport');

    const outcome = await fillField(
      port,
      { field: 'Airport', target: field },
      { kind: 'text', text: 'DFW' },
      budget(port),
    );

    expect(outcome).toMatchObject({
      ok: false,
      errorCode: 'WIDGET_NOT_COMMITTED',
      details: { observed: 'xyz' },
    });
    if (outcome.ok) return;
    expect((outcome.details.attempted as unknown[]).length).toBe(3);
  });

  it('carries observed state and the attempt ledger on a failure', async () => {
    const port = new WidgetTestPort('<input id="q" aria-label="Search">');
    const input = port.document.querySelector<HTMLInputElement>('#q')!;
    Object.defineProperty(input, 'value', {
      get: () => '',
      set: () => undefined,
      configurable: true,
    });
    const field = target(port, '#q', 'textbox', 'Search');

    const outcome = await fillField(
      port,
      { field: 'Search', target: field },
      { kind: 'text', text: 'winter coat' },
      budget(port),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.errorCode).toBe('WIDGET_NOT_COMMITTED');
    expect(outcome.details.observed).toBe('');
    expect(Array.isArray(outcome.details.attempted)).toBe(true);
    expect((outcome.details.attempted as unknown[]).length).toBeGreaterThan(1);
  });

  it('gives two failures with the same code different next steps', () => {
    // The run received one identical sentence for four unrelated causes. The
    // next step is now selected by why the failure happened, not inferred from
    // whichever detail keys happen to be present.
    const holding = fillFailureFor('control-refused-value', { observed: 'Fort Wayne' });
    const exhausted = fillFailureFor('typing-exhausted', {
      observed: '',
      attempted: [
        {
          attempt: 1,
          strategy: 'overtype',
          axis: 'how',
          errorCode: 'WIDGET_NOT_COMMITTED',
          elapsedMs: 1,
        },
        {
          attempt: 2,
          strategy: 'clear-then-type',
          axis: 'how',
          errorCode: 'WIDGET_NOT_COMMITTED',
          elapsedMs: 1,
        },
      ],
    });
    const delegated = fillFailureFor('keystrokes-landed-elsewhere', {
      observed: '',
      editee: 'Search airports',
    });

    expect(new Set([holding, exhausted, delegated].map((f) => f.details.hint)).size).toBe(3);
    expect(holding.details.hint).toContain('Fort Wayne');
    expect(exhausted.details.hint).toContain('details.attempted');
    expect(delegated.details.hint).toContain('Search airports');
  });

  it('points at what the widget offers when that is what the cause is', () => {
    const failure = fillFailure(
      'WIDGET_TARGET_UNREACHABLE',
      'value-not-offered',
      'The widget does not offer that.',
      { observed: '', offered: ['Dallas', 'Denver'] },
    );
    expect(failure.details.hint).toContain('"Dallas"');
    expect(failure.details.hint).toContain('exactly as written');
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
  ])(
    'returns the tied suggestions for the caller to choose between, for %s',
    async (_l, intent) => {
      const port = suggestionPort(['New York, NY', 'New York, USA']);
      const field = target(port, '#airport', 'textbox', 'Going to');

      const outcome = await fillField(
        port,
        { field: 'Going to', target: field },
        intent,
        budget(port),
      );

      // This used to report `plain-text` success with the raw typed text left in
      // the box — a form that looked filled and was not, because the site
      // discards unresolved text on submit. Picking one of the tied names is
      // still the guess this engine refuses to make; handing the choice back with
      // the labels costs one call and cannot commit the wrong city.
      expect(outcome).toMatchObject({ ok: false, errorCode: 'WIDGET_AMBIGUOUS_CHOICE' });
      if (outcome.ok) return;
      expect(outcome.details.offered).toEqual(['New York, NY', 'New York, USA']);
      expect(String(outcome.details.hint)).toContain('exactly as written');
    },
  );

  it('commits the chosen option when the caller re-issues with its exact text', async () => {
    const port = suggestionPort(['New York, NY', 'New York, USA']);
    const field = target(port, '#airport', 'textbox', 'Going to');

    const outcome = await fillField(
      port,
      { field: 'Going to', target: field },
      { kind: 'text', text: 'New York, USA' },
      budget(port),
    );

    expect(outcome).toMatchObject({
      ok: true,
      driver: 'typeahead',
      committed: 'New York, USA',
      resolution: 'selected_from_offered',
    });
  });

  it('keeps typed text that the page lets stand when nothing matches', async () => {
    const port = suggestionPort(['Boston, MA', 'Chicago, IL']);
    const field = target(port, '#airport', 'textbox', 'Going to');

    const outcome = await fillField(
      port,
      { field: 'Going to', target: field },
      { kind: 'text', text: 'Reykjavik' },
      budget(port),
    );

    expect(outcome).toMatchObject({ ok: true, driver: 'plain-text', committed: 'Reykjavik' });
  });

  it('reports a control that discards free text, naming what it does offer', async () => {
    const port = suggestionPort(['Boston, MA', 'Chicago, IL']);
    const input = port.document.querySelector<HTMLInputElement>('#airport')!;
    // A field that will not hold anything it did not offer. Whether a control
    // behaves this way is read from the page, never assumed from its markup.
    port.document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') input.value = '';
    });
    const field = target(port, '#airport', 'textbox', 'Going to');

    const outcome = await fillField(
      port,
      { field: 'Going to', target: field },
      { kind: 'text', text: 'Reykjavik' },
      budget(port),
    );

    expect(outcome).toMatchObject({ ok: false, errorCode: 'WIDGET_TARGET_UNREACHABLE' });
    if (outcome.ok) return;
    expect(outcome.details.offered).toEqual(['Boston, MA', 'Chicago, IL']);
  });

  it('reads a suggestion list that only arrives well past the old fixed wait', async () => {
    // A remote autocomplete on a cold page answers late. The old 1.5s cap read
    // an empty popup and moved on; holding out for content until the list
    // appears is what makes this reachable at all.
    const port = latePopupPort(['Reykjavik, Iceland'], 2_500);
    const field = target(port, '#airport', 'textbox', 'Going to');

    const outcome = await fillField(
      port,
      { field: 'Going to', target: field },
      { kind: 'text', text: 'Reykjavik' },
      budget(port),
    );

    expect(outcome).toMatchObject({ ok: true, committed: 'Reykjavik, Iceland' });
  }, 20_000);

  it('ranks the list only once it has stopped changing', async () => {
    // While a list is still growing, any read of it is a read of a partial
    // answer. Ranking one of those is how a control ends up committing an
    // option that was never the best match.
    const port = growingPopupPort(
      [['Reyk'], ['Reykjavik, Canada'], ['Reykjavik, Canada', 'Reykjavik, Iceland']],
      200,
    );
    const field = target(port, '#airport', 'textbox', 'Going to');

    const outcome = await fillField(
      port,
      { field: 'Going to', target: field },
      { kind: 'text', text: 'Reykjavik, Iceland' },
      budget(port),
    );

    expect(outcome).toMatchObject({ ok: true, committed: 'Reykjavik, Iceland' });
  }, 20_000);

  it('still refuses to guess on a control that cannot hold typed text', async () => {
    const port = new WidgetTestPort(
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
    const outcome = await watchAndSelectOffered(port, field, 'Zurich', budget(port));

    expect(outcome).toMatchObject({ kind: 'unmatched-text-stands' });
    expect((port.document.querySelector('#airport') as HTMLInputElement).value).toBe('Zurich');
  });

  it('commits literal text when no popup appears within the bounded watch', async () => {
    let clock = 0;
    const port = new WidgetTestPort('<input id="note" aria-label="Note">', () => {
      clock += 2_000;
      return clock;
    });
    const field = target(port, '#note', 'textbox', 'Note');

    await port.fill(field.ref, 'quiet room');
    const outcome = await watchAndSelectOffered(port, field, 'quiet room', {
      deadlineMs: 100_000,
      maxActions: 8,
    });

    expect(outcome).toMatchObject({
      kind: 'no-suggestions',
      committed: 'quiet room',
      dismissed: false,
    });
  });
});

describe('@no-llm commit-and-dismiss lifecycle', () => {
  it('prefers one visible commit control and verifies that the value survives', async () => {
    const port = new WidgetTestPort(
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
    const port = new WidgetTestPort(
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
    const port = new WidgetTestPort(
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

    const port = new WidgetTestPort(
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
): WidgetTestPort {
  const cell = (day: number, disabled: boolean): string =>
    `<td><button data-date="2026-09-0${day}"${disabled ? ' aria-disabled="true"' : ''}>${day}</button></td>`;
  const port = new WidgetTestPort(
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

/** A typeahead whose popup stays empty until `afterMs` has elapsed. */
function latePopupPort(options: readonly string[], afterMs: number): WidgetTestPort {
  return timedPopupPort([[], options], afterMs);
}

/** A typeahead whose popup grows through `stages`, one every `everyMs`. */
function growingPopupPort(stages: readonly (readonly string[])[], everyMs: number): WidgetTestPort {
  return timedPopupPort(stages, everyMs);
}

/** Renders each stage of a suggestion list on a real timer after typing. */
function timedPopupPort(stages: readonly (readonly string[])[], everyMs: number): WidgetTestPort {
  const port = new WidgetTestPort(
    '<input id="airport" aria-label="Going to" aria-controls="suggestions">' +
      '<div id="suggestions" role="listbox" style="display:none"></div>',
  );
  const input = port.document.querySelector<HTMLInputElement>('#airport')!;
  const popup = port.document.querySelector<HTMLElement>('#suggestions')!;
  const render = (options: readonly string[]): void => {
    popup.innerHTML = options.map((option) => `<button role="option">${option}</button>`).join('');
    for (const button of popup.querySelectorAll('button')) {
      button.addEventListener('click', () => {
        input.value = button.textContent ?? '';
        popup.style.display = 'none';
      });
    }
  };
  let started = false;
  input.addEventListener('input', () => {
    popup.style.display = 'block';
    if (started) return;
    started = true;
    stages.forEach((stage, index) => {
      if (index === 0) render(stage);
      else setTimeout(() => render(stage), everyMs * index);
    });
  });
  port.document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') popup.style.display = 'none';
  });
  return port;
}

/**
 * A typeahead whose committed value may legitimately differ from the option
 * label, which is what real location pickers do: the list offers
 * "<City> <Airport> (<CODE>)" and the field settles on the short display name.
 */
function suggestionPort(options: readonly string[], commitsAs?: string): WidgetTestPort {
  const port = new WidgetTestPort(
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
      input.value = commitsAs ?? option.textContent ?? '';
      popup.style.display = 'none';
    });
  });
  port.document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') popup.style.display = 'none';
  });
  return port;
}

describe('@no-llm secret fills are excluded from editee resolution', () => {
  it('takes no observation and reads nothing back when committing a secret', async () => {
    // Locating an editee means searching every observed interactable for the
    // value that was sent. For a credential that is a readback of
    // secret-derived state compared against the whole page, so the WHERE rung
    // is structurally unreachable from the secret path — not merely unused.
    const port = new WidgetTestPort('<input id="p" type="password" aria-label="Password" />');
    const field = target(port, '#p', 'textbox', 'Password');
    const observations: string[] = [];
    const watched = new Proxy(port, {
      get(source, key, receiver) {
        if (key === 'observe') {
          return async () => {
            observations.push('observe');
            return source.observe();
          };
        }
        return Reflect.get(source, key, receiver) as unknown;
      },
    });

    const outcome = await fillSecretField(
      watched,
      { field: 'Password', target: field },
      'hunter2',
      {
        deadlineMs: port.now() + 10_000,
        maxActions: 8,
        maxPagingSteps: 12,
      },
    );

    expect(outcome).toMatchObject({ ok: true, driver: 'plain-text', committed: '' });
    expect(observations).toEqual([]);
    expect(JSON.stringify(outcome)).not.toContain('hunter2');
  });
});
