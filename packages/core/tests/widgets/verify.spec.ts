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
