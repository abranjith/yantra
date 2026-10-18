import { describe, expect, it, vi } from 'vitest';

import { committedText } from '../../src/interaction/protected-value.js';
import { matchesCommitment, matchesIntent, readCommittedValue } from '../../src/widgets/index.js';
import { WidgetTestPort } from '../support/widget-test-port.js';

describe('@no-llm widget committed-value verification', () => {
  it('matches locale-rendered date ranges in order', () => {
    expect(
      matchesIntent('Thu, Sep 6 - Sat, Sep 8', {
        kind: 'date_range',
        from: '2026-09-06',
        to: '2026-09-08',
      }),
    ).toBe(true);
    expect(
      matchesIntent('Sep 3 - Sep 4', {
        kind: 'date_range',
        from: '2026-09-06',
        to: '2026-09-08',
      }),
    ).toBe(false);
  });

  it('matches non-English Intl-rendered committed dates', () => {
    expect(matchesIntent('dimanche 6 septembre 2026', { kind: 'date', date: '2026-09-06' })).toBe(
      true,
    );
    expect(matchesIntent('dimanche 7 septembre 2026', { kind: 'date', date: '2026-09-06' })).toBe(
      false,
    );
  });

  it('normalizes punctuation, case, and whitespace for option containment', () => {
    expect(
      matchesIntent('Frisco Texas, United States', { kind: 'option', value: 'frisco, texas' }),
    ).toBe(true);
    expect(matchesIntent('Toyota Stadium', { kind: 'option', value: 'Frisco' })).toBe(false);
  });

  it('reads a slashed numeric date in either field order', () => {
    // The rendered text carries no signal about its own order, and the engine
    // used to keep a second, month-first-only matcher that called a correct
    // day-first commit uncommitted.
    expect(matchesIntent('21/08/2026', { kind: 'date', date: '2026-08-21' })).toBe(true);
    expect(matchesIntent('08/21/2026', { kind: 'date', date: '2026-08-21' })).toBe(true);
    expect(matchesIntent('08/21/2026', { kind: 'date', date: '2026-08-08' })).toBe(false);
  });

  it('accepts a committed date that renders no year', () => {
    // Compact pickers render "Sun, Sep 6"; demanding a year rejects them.
    expect(matchesIntent('Sun, Sep 6', { kind: 'date', date: '2026-09-06' })).toBe(true);
    expect(matchesIntent('Sun, Sep 6', { kind: 'date', date: '2026-09-07' })).toBe(false);
    // A year that is present must still agree.
    expect(matchesIntent('Sep 6, 2025', { kind: 'date', date: '2026-09-06' })).toBe(false);
  });

  it('accepts a slashed numeric date that renders no year', () => {
    // KAYAK's date trigger shows "Sun 9/6" and nothing else; requiring a year
    // called its landed selection uncommitted.
    expect(matchesIntent('Sun 9/6', { kind: 'date', date: '2026-09-06' })).toBe(true);
    expect(matchesIntent('Sun 9/6', { kind: 'date', date: '2026-06-09' })).toBe(true);
    expect(matchesIntent('Sun 9/6', { kind: 'date', date: '2026-09-07' })).toBe(false);
    // A full date still yields one reading per field order, not four.
    expect(matchesIntent('9/6/2026', { kind: 'date', date: '2026-09-06' })).toBe(true);
    expect(matchesIntent('9/6/2026', { kind: 'date', date: '2025-09-06' })).toBe(false);
    // A decimal is a number. Only the slash admits the year-less form.
    expect(matchesIntent('1.5 miles away', { kind: 'date', date: '2026-01-05' })).toBe(false);
  });

  it('reads a control that labels itself one thing and displays another', async () => {
    // KAYAK's trigger keeps the fixed label "Select start date from calendar
    // input" and renders the chosen day as its text. Reading only the first
    // non-empty source meant reading the one that never changes.
    const port = new WidgetTestPort(
      '<div id="trigger" role="button" aria-label="Select start date from calendar input">Sun 9/6</div>',
    );
    const target = {
      ref: 'e1',
      role: 'button',
      name: 'Select start date from calendar input',
      group: null,
      value: null,
    };
    const read = await readCommittedValue(port, target);
    expect(read).toEqual({
      kind: 'disclosed',
      text: 'Select start date from calendar input Sun 9/6',
    });
    const committed = committedText(read)!;
    expect(matchesIntent(committed, { kind: 'date', date: '2026-09-06' })).toBe(true);
  });

  it('never repeats a value a control states twice', async () => {
    // A label and text that agree must not read as two dates, or an ordered
    // range check accepts "Sep 6" as the range Sep 6 → Sep 6.
    const port = new WidgetTestPort(
      '<div id="trigger" role="button" aria-label="Sep 6">Sep 6</div>',
    );
    const committed = committedText(
      await readCommittedValue(port, {
        ref: 'e1',
        role: 'button',
        name: 'Sep 6',
        group: null,
        value: null,
      }),
    )!;
    expect(committed).toBe('Sep 6');
    expect(
      matchesIntent(committed, { kind: 'date_range', from: '2026-09-06', to: '2026-09-06' }),
    ).toBe(false);
  });

  it('never returns credential, OTP, payment, or marked input values', async () => {
    for (const [input, reason] of [
      ['<input id="trigger" type="password" value="CANARY-protected-value">', 'password'],
      [
        '<input id="trigger" autocomplete="one-time-code" value="CANARY-protected-value">',
        'autocomplete',
      ],
      [
        '<input id="trigger" autocomplete="cc-number" value="CANARY-protected-value">',
        'autocomplete',
      ],
      ['<input id="trigger" data-yantra-secret value="CANARY-protected-value">', 'secret_marker'],
    ] as const) {
      const port = new WidgetTestPort(input);
      const blind = await readCommittedValue(port, textbox);
      expect(blind).toEqual({ kind: 'withheld', reason, present: true, match: null });
      expect(JSON.stringify(blind)).not.toContain('CANARY-protected-value');
      // Never the ordinary empty string a withheld read used to be.
      expect(committedText(blind)).toBeNull();

      const checked = await readCommittedValue(port, textbox, {
        expected: 'CANARY-protected-value',
      });
      expect(checked).toEqual({ kind: 'withheld', reason, present: true, match: 'exact' });
      expect(JSON.stringify(checked)).not.toContain('CANARY-protected-value');
    }
  });

  it('judges a withheld value inside the page without returning it', async () => {
    const port = new WidgetTestPort('<input id="trigger" type="password" value="Passw0">');
    for (const [expected, match] of [
      ['Passw0', 'exact'],
      ['passw0', 'reformatted'],
      ['Passw0rd!', 'truncated'],
      ['hunter2', 'different'],
    ] as const) {
      expect(await readCommittedValue(port, textbox, { expected })).toEqual({
        kind: 'withheld',
        reason: 'password',
        present: true,
        match,
      });
    }
    port.document.querySelector('input')!.value = '';
    expect(await readCommittedValue(port, textbox, { expected: 'Passw0' })).toEqual({
      kind: 'withheld',
      reason: 'password',
      present: false,
      match: 'empty',
    });
  });

  it('reads disclosed controls exactly as before', async () => {
    const text = new WidgetTestPort('<input id="trigger" value="  Frisco,   Texas ">');
    expect(await readCommittedValue(text, textbox)).toEqual({
      kind: 'disclosed',
      text: 'Frisco, Texas',
    });
    // An expected value changes nothing about a disclosed read.
    expect(await readCommittedValue(text, textbox, { expected: 'Frisco' })).toEqual({
      kind: 'disclosed',
      text: 'Frisco, Texas',
    });
    const select = new WidgetTestPort(
      '<select id="trigger"><option>Economy</option><option selected>Business</option></select>',
    );
    expect(await readCommittedValue(select, textbox)).toEqual({
      kind: 'disclosed',
      text: 'Business',
    });
    const slider = new WidgetTestPort(
      '<div id="trigger" role="button" aria-valuetext="5 stars" aria-label="Rating"></div>',
    );
    expect(await readCommittedValue(slider, textbox)).toEqual({
      kind: 'disclosed',
      text: '5 stars Rating',
    });
  });

  it('reads only the box itself on the raw source', async () => {
    // A trigger whose accessible name differs from its text: the committed read
    // reports both, the raw read only what is in the box.
    const port = new WidgetTestPort(
      '<div id="trigger" role="combobox" aria-label="Departure airport">DF</div>',
    );
    expect(await readCommittedValue(port, textbox)).toEqual({
      kind: 'disclosed',
      text: 'Departure airport DF',
    });
    expect(await readCommittedValue(port, textbox, { source: 'raw' })).toEqual({
      kind: 'disclosed',
      text: 'DF',
    });
    const field = new WidgetTestPort('<input id="trigger" aria-label="Code" value=" DF W ">');
    expect(await readCommittedValue(field, textbox, { source: 'raw' })).toEqual({
      kind: 'disclosed',
      text: 'DF W',
    });
  });

  it('takes the same single page read as the read it replaced', async () => {
    const port = new WidgetTestPort('<input id="trigger" type="password" value="x">');
    const evaluateOn = vi.spyOn(port, 'evaluateOn');
    await readCommittedValue(port, textbox, { expected: 'x' });
    expect(evaluateOn).toHaveBeenCalledTimes(1);
  });
});

const textbox = { ref: 'e1', role: 'textbox', name: 'Field', group: null, value: null };

describe('@no-llm commitment verification against the chosen option', () => {
  it('accepts a short display name for the option that carried the code', () => {
    // The motivating case: typed "DFW", the list offered the full airport
    // name, and the field settled on "Dallas". Checked against the typed text
    // this reads as a failure; checked against the option actually clicked, it
    // is plainly correct.
    expect(matchesCommitment('Dallas', 'Dallas Fort Worth International Airport (DFW)')).toBe(true);
  });

  it('accepts a control that renders more than the option label', () => {
    expect(matchesCommitment('Dallas (DFW), United States', 'Dallas')).toBe(true);
  });

  it('rejects a value with nothing in common with the chosen option', () => {
    expect(matchesCommitment('Fort Wayne', 'Dallas Fort Worth International Airport (DFW)')).toBe(
      false,
    );
  });

  it('rejects an empty commitment on either side', () => {
    expect(matchesCommitment('', 'Dallas')).toBe(false);
    expect(matchesCommitment('Dallas', '')).toBe(false);
    expect(matchesCommitment('   ', 'Dallas')).toBe(false);
  });

  it('ignores case and punctuation differences', () => {
    expect(matchesCommitment('SAN JOSE, CA', 'San Jose (CA)')).toBe(true);
  });
});
