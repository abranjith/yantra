import { describe, expect, it } from 'vitest';

import { parseSince } from './usage.js';

describe('@no-llm usage parseSince', () => {
  const now = new Date('2026-07-10T12:00:00.000Z');

  it('resolves a day-age spec relative to now', () => {
    expect(parseSince('7d', now)).toBe('2026-07-03T12:00:00.000Z');
  });

  it('resolves an hour-age spec relative to now', () => {
    expect(parseSince('24h', now)).toBe('2026-07-09T12:00:00.000Z');
  });

  it('passes a calendar date through unchanged (lexical compare against ISO)', () => {
    expect(parseSince('2026-07-01', now)).toBe('2026-07-01');
  });

  it('rejects an unparseable value', () => {
    expect(parseSince('yesterday', now)).toBeNull();
    expect(parseSince('7', now)).toBeNull();
    expect(parseSince('7w', now)).toBeNull();
  });
});
