import { describe, expect, it } from 'vitest';

import {
  classifyFailure,
  withAttempts,
  type AttemptOptions,
  type AttemptOutcome,
} from '../../src/index.js';

interface TestFailure {
  readonly errorCode: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

/** A clock that advances only when the test says so. */
function fakeClock(stepMs = 10): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let current = 1_000;
  return {
    now: () => {
      current += stepMs;
      return current;
    },
    sleep: async (ms: number) => {
      current += ms;
      await Promise.resolve();
    },
  };
}

function options(
  clock: ReturnType<typeof fakeClock>,
  overrides: Partial<AttemptOptions<TestFailure>> = {},
): AttemptOptions<TestFailure> {
  return {
    maxAttempts: 3,
    deadlineMs: Number.MAX_SAFE_INTEGER,
    backoffMs: [10, 20],
    classify: (failure) => classifyFailure(failure.errorCode, failure.details ?? {}),
    describe: (failure) => ({ errorCode: failure.errorCode }),
    now: clock.now,
    sleep: clock.sleep,
    ...overrides,
  };
}

const fail = (
  errorCode: string,
  details?: Record<string, unknown>,
): AttemptOutcome<never, TestFailure> => ({
  ok: false,
  failure: details === undefined ? { errorCode } : { errorCode, details },
});

describe('@no-llm classifyFailure', () => {
  it('treats page-moved-underneath codes as transient', () => {
    for (const code of [
      'WIDGET_ELEMENT_REPLACED',
      'STALE_ELEMENT_REF',
      'ELEMENT_HIDDEN',
      'WIDGET_DID_NOT_OPEN',
      'WIDGET_NOT_COMMITTED',
    ]) {
      expect(classifyFailure(code)).toBe('transient');
    }
  });

  it('treats definite answers from the page as terminal', () => {
    for (const code of [
      'WIDGET_AMBIGUOUS_CHOICE',
      'WIDGET_MAPPING_UNSAFE',
      'WIDGET_RANGE_INCOMPLETE',
      'FILL_VALUE_INVALID',
      'SECRET_HOST_MISMATCH',
      'ELEMENT_DISABLED',
      'OPTION_NOT_FOUND',
    ]) {
      expect(classifyFailure(code)).toBe('terminal');
    }
  });

  it('lets an exhausted budget or a disabled target override a transient code', () => {
    expect(classifyFailure('WIDGET_NOT_COMMITTED', { reason: 'budget' })).toBe('terminal');
    expect(classifyFailure('WIDGET_NOT_COMMITTED', { reason: 'disabled' })).toBe('terminal');
  });

  it('defaults an unrecognized code to terminal so it cannot loop', () => {
    expect(classifyFailure('SOME_FUTURE_CODE')).toBe('terminal');
    expect(classifyFailure('')).toBe('terminal');
  });
});

describe('@no-llm withAttempts', () => {
  it('retries a transient failure and records both attempts in the ledger', async () => {
    const clock = fakeClock();
    const seen: number[] = [];

    const run = await withAttempts<string, TestFailure>(async (attempt) => {
      seen.push(attempt);
      return attempt === 1 ? fail('WIDGET_ELEMENT_REPLACED') : { ok: true, value: 'landed' };
    }, options(clock));

    expect(seen).toEqual([1, 2]);
    expect(run.outcome).toEqual({ ok: true, value: 'landed' });
    expect(run.ledger.records).toHaveLength(2);
    expect(run.ledger.records[0]).toMatchObject({
      attempt: 1,
      strategy: 'attempt-1',
      errorCode: 'WIDGET_ELEMENT_REPLACED',
    });
    expect(run.ledger.records[1]).toMatchObject({ attempt: 2, errorCode: null });
  });

  it('records the successful attempt even when it is the only one', async () => {
    const clock = fakeClock();

    const run = await withAttempts<number, TestFailure>(
      async () => ({ ok: true, value: 7 }),
      options(clock),
    );

    expect(run.ledger.records).toEqual([
      { attempt: 1, strategy: 'attempt-1', errorCode: null, elapsedMs: expect.any(Number) },
    ]);
  });

  it('does not retry a terminal failure', async () => {
    const clock = fakeClock();
    let calls = 0;

    const run = await withAttempts<string, TestFailure>(async () => {
      calls += 1;
      return fail('WIDGET_AMBIGUOUS_CHOICE');
    }, options(clock));

    expect(calls).toBe(1);
    expect(run.outcome.ok).toBe(false);
    expect(run.ledger.records).toHaveLength(1);
  });

  it('honors maxAttempts and returns the last observed failure verbatim', async () => {
    const clock = fakeClock();
    let calls = 0;

    const run = await withAttempts<string, TestFailure>(
      async (attempt) => {
        calls += 1;
        return fail('WIDGET_NOT_COMMITTED', { attempt });
      },
      options(clock, { maxAttempts: 3 }),
    );

    expect(calls).toBe(3);
    expect(run.outcome).toEqual({
      ok: false,
      failure: { errorCode: 'WIDGET_NOT_COMMITTED', details: { attempt: 3 } },
    });
    expect(run.ledger.records).toHaveLength(3);
  });

  it('stops before an attempt that could not start inside the deadline', async () => {
    const clock = fakeClock(10);
    let calls = 0;

    const run = await withAttempts<string, TestFailure>(
      async () => {
        calls += 1;
        return fail('STALE_ELEMENT_REF');
      },
      options(clock, { maxAttempts: 10, deadlineMs: 1_040, backoffMs: [50] }),
    );

    expect(calls).toBeLessThan(10);
    expect(run.outcome.ok).toBe(false);
    expect(run.ledger.records.length).toBe(calls);
  });

  it('consumes the backoff sequence in order and repeats its final entry', async () => {
    const clock = fakeClock(0);
    const slept: number[] = [];

    await withAttempts<string, TestFailure>(async () => fail('ELEMENT_HIDDEN'), {
      ...options(clock, { maxAttempts: 4, backoffMs: [5, 25] }),
      sleep: async (ms: number) => {
        slept.push(ms);
        await Promise.resolve();
      },
    });

    expect(slept).toEqual([5, 25, 25]);
  });

  it('labels each attempt with the caller-supplied strategy name', async () => {
    const clock = fakeClock();
    const ladder = ['overtype', 'clear-then-type', 'native-setter'];

    const run = await withAttempts<string, TestFailure>(
      async (attempt) => (attempt < 3 ? fail('WIDGET_NOT_COMMITTED') : { ok: true, value: 'ok' }),
      options(clock, { label: (attempt) => ladder[attempt - 1] ?? `attempt-${attempt}` }),
    );

    expect(run.ledger.records.map((record) => record.strategy)).toEqual(ladder);
  });

  it('carries a failure detail clause into the ledger', async () => {
    const clock = fakeClock();

    const run = await withAttempts<string, TestFailure>(async () => fail('WIDGET_MAPPING_UNSAFE'), {
      ...options(clock),
      describe: (failure) => ({ errorCode: failure.errorCode, detail: 'headers disagreed' }),
    });

    expect(run.ledger.records[0]?.detail).toBe('headers disagreed');
  });

  it('treats maxAttempts below one as a single attempt', async () => {
    const clock = fakeClock();
    let calls = 0;

    await withAttempts<string, TestFailure>(
      async () => {
        calls += 1;
        return fail('STALE_ELEMENT_REF');
      },
      options(clock, { maxAttempts: 0 }),
    );

    expect(calls).toBe(1);
  });

  it('tolerates an empty backoff sequence without sleeping', async () => {
    const clock = fakeClock();
    const slept: number[] = [];

    const run = await withAttempts<string, TestFailure>(
      async (attempt) => (attempt === 1 ? fail('STALE_ELEMENT_REF') : { ok: true, value: 'ok' }),
      {
        ...options(clock, { backoffMs: [] }),
        sleep: async (ms: number) => {
          slept.push(ms);
          await Promise.resolve();
        },
      },
    );

    expect(slept).toEqual([]);
    expect(run.outcome.ok).toBe(true);
  });
});
