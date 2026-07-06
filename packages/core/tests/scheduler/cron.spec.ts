import { describe, expect, it } from 'vitest';

import { nextFire, nextFireIso, validateCron } from '../../src/scheduler/cron.js';

describe('@no-llm cron helpers', () => {
  describe('validateCron', () => {
    it('accepts a standard 5-field expression', () => {
      expect(validateCron('*/5 * * * *')).toEqual({ ok: true });
    });

    it('accepts a 6-field (seconds) expression', () => {
      expect(validateCron('0 */5 * * * *')).toEqual({ ok: true });
    });

    it('rejects a non-cron string with a reason', () => {
      const result = validateCron('not a cron');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason.length).toBeGreaterThan(0);
      }
    });

    it('rejects an empty expression', () => {
      const result = validateCron('   ');
      expect(result.ok).toBe(false);
    });
  });

  describe('nextFire', () => {
    it('computes the next fire strictly after the reference instant (fixed clock)', () => {
      const from = new Date('2026-07-05T00:02:30.000Z');
      const next = nextFire('*/5 * * * *', from);
      // Next 5-minute boundary strictly after 00:02:30 is 00:05:00.
      expect(next?.toISOString()).toBe('2026-07-05T00:05:00.000Z');
    });

    it('never returns the reference instant itself when it is a fire time', () => {
      const from = new Date('2026-07-05T00:05:00.000Z');
      const next = nextFire('*/5 * * * *', from);
      expect(next?.toISOString()).toBe('2026-07-05T00:10:00.000Z');
    });

    it('produces an ISO string via nextFireIso', () => {
      const from = new Date('2026-07-05T00:02:30.000Z');
      expect(nextFireIso('*/5 * * * *', from)).toBe('2026-07-05T00:05:00.000Z');
    });
  });
});
