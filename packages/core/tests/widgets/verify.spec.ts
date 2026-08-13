import { describe, expect, it } from 'vitest';

import { matchesIntent, readCommitted } from '../../src/widgets/index.js';

import { CalendarTestPort } from './calendar-test-port.js';

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
    const port = new CalendarTestPort(
      '<div id="trigger" role="button" aria-label="Select start date from calendar input">Sun 9/6</div>',
    );
    const target = {
      ref: 'e1',
      role: 'button',
      name: 'Select start date from calendar input',
      group: null,
      value: null,
    };
    const committed = await readCommitted(port, target);
    expect(committed).toBe('Select start date from calendar input Sun 9/6');
    expect(matchesIntent(committed, { kind: 'date', date: '2026-09-06' })).toBe(true);
  });

  it('never repeats a value a control states twice', async () => {
    // A label and text that agree must not read as two dates, or an ordered
    // range check accepts "Sep 6" as the range Sep 6 → Sep 6.
    const port = new CalendarTestPort(
      '<div id="trigger" role="button" aria-label="Sep 6">Sep 6</div>',
    );
    const committed = await readCommitted(port, {
      ref: 'e1',
      role: 'button',
      name: 'Sep 6',
      group: null,
      value: null,
    });
    expect(committed).toBe('Sep 6');
    expect(
      matchesIntent(committed, { kind: 'date_range', from: '2026-09-06', to: '2026-09-06' }),
    ).toBe(false);
  });

  it('never reads credential, OTP, or payment input values', async () => {
    for (const input of [
      '<input id="trigger" type="password" value="password-canary">',
      '<input id="trigger" autocomplete="one-time-code" value="123456">',
      '<input id="trigger" autocomplete="cc-number" value="4111111111111111">',
      '<input id="trigger" data-yantra-secret value="secret-canary">',
    ]) {
      const port = new CalendarTestPort(input);
      await expect(
        readCommitted(port, {
          ref: 'e1',
          role: 'textbox',
          name: 'Sensitive',
          group: null,
          value: null,
        }),
      ).resolves.toBe('');
    }
  });
});
