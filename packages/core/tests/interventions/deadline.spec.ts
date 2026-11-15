import { describe, expect, it } from 'vitest';

import {
  computeAttendedDeadline,
  effectiveDeadlineAt,
  UnattendedCeilingClock,
  UNATTENDED_CEILING_MS,
} from '../../src/interventions/deadline.js';

const start = Date.parse('2026-11-03T12:00:00.000Z');

function steppedClock() {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
    current: () => current,
  };
}

describe('@no-llm intervention deadlines', () => {
  it('expires after exactly 15 minutes of unattended accrual', () => {
    const time = steppedClock();
    const clock = new UnattendedCeilingClock({ now: time.now });
    time.advance(UNATTENDED_CEILING_MS - 1);
    expect(clock.isExpired()).toBe(false);
    time.advance(1);
    expect(clock.isExpired()).toBe(true);
    expect(clock.ceilingDeadlineAt()).toBe(time.current());
  });

  it('does not extend the ceiling when attendance flaps', () => {
    const time = steppedClock();
    const clock = new UnattendedCeilingClock({ now: time.now });
    time.advance(5 * 60_000);
    clock.setAttendance(1);
    time.advance(60_000);
    clock.setAttendance(0);
    time.advance(5 * 60_000);
    clock.setAttendance(1);
    time.advance(60_000);
    clock.setAttendance(0);
    time.advance(5 * 60_000);
    expect(clock.isExpired()).toBe(true);
    expect(clock.accrued()).toBe(15 * 60_000);
  });

  it('uses only attendance count, not host or queue state', () => {
    const time = steppedClock();
    const clock = new UnattendedCeilingClock({ now: time.now });
    expect(clock.attendance()).toBe(0);
    expect(clock.ceilingDeadlineAt()).toBe(start + UNATTENDED_CEILING_MS);
  });

  it('caps an attended agentic wait at the agent confirmation timeout', () => {
    const result = computeAttendedDeadline({
      requestedAt: new Date(start).toISOString(),
      timeoutMs: null,
      agentConfirmTimeoutMs: 3 * 60_000,
      wallClockDeadlineAt: null,
    });
    expect(result).toEqual({
      attendedDeadlineAt: new Date(start + 3 * 60_000).toISOString(),
      basis: 'agent_confirm_timeout',
    });
  });

  it('selects the earliest wall-clock bound and combines it with the ceiling', () => {
    const attended = computeAttendedDeadline({
      requestedAt: new Date(start).toISOString(),
      timeoutMs: 10 * 60_000,
      agentConfirmTimeoutMs: null,
      wallClockDeadlineAt: new Date(start + 5 * 60_000).toISOString(),
    });
    expect(attended.basis).toBe('wall_clock');

    const time = steppedClock();
    const clock = new UnattendedCeilingClock({ now: time.now });
    expect(effectiveDeadlineAt(attended.attendedDeadlineAt, clock, start)).toBe(
      new Date(start + 5 * 60_000).toISOString(),
    );
  });

  it('counts a sleep jump immediately on wake and ignores attended jumps', () => {
    const time = steppedClock();
    const clock = new UnattendedCeilingClock({ now: time.now });
    time.advance(40 * 60_000);
    expect(clock.isExpired()).toBe(true);

    const attendedTime = steppedClock();
    const attended = new UnattendedCeilingClock({ now: attendedTime.now });
    attended.setAttendance(1);
    attendedTime.advance(40 * 60_000);
    expect(attended.isExpired()).toBe(false);
  });

  it('seeds previous unattended accrual', () => {
    const time = steppedClock();
    const clock = new UnattendedCeilingClock({ seedAccruedMs: 14 * 60_000, now: time.now });
    time.advance(60_000);
    expect(clock.isExpired()).toBe(true);
  });
});
