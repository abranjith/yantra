import { describe, expect, it } from 'vitest';

import { formatWhen, NOT_RECORDED } from '../../src/features/format.js';

const NOW = new Date(2026, 10, 22, 21, 50);

function at(year: number, month: number, day: number, hour: number, minute: number): string {
  return new Date(year, month, day, hour, minute).toISOString();
}

describe('@no-llm formatWhen', () => {
  it('says Today and Yesterday for the last two days', () => {
    expect(formatWhen(at(2026, 10, 22, 21, 42), NOW)).toMatch(/^Today, /u);
    expect(formatWhen(at(2026, 10, 21, 16, 30), NOW)).toMatch(/^Yesterday, /u);
  });

  it('gives the day and time earlier this year, and the date in another year', () => {
    const earlier = formatWhen(at(2026, 10, 20, 11, 22), NOW);
    expect(earlier).not.toMatch(/Today|Yesterday|2026/u);
    expect(earlier).toContain(',');
    expect(formatWhen(at(2025, 9, 23, 2, 42), NOW)).toContain('2025');
  });

  it('keeps unparseable text and marks a missing time', () => {
    expect(formatWhen('not a time', NOW)).toBe('not a time');
    expect(formatWhen(undefined, NOW)).toBe(NOT_RECORDED);
  });
});
