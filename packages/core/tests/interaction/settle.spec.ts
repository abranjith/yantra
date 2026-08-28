import { describe, expect, it } from 'vitest';

import { readWhenStable, type StabilityOptions } from '../../src/index.js';

/** A clock that only moves when the code under test sleeps. */
function fakeClock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let current = 0;
  return {
    now: () => current,
    sleep: async (ms: number) => {
      current += ms;
      await Promise.resolve();
    },
  };
}

/** Reads a scripted sequence, repeating its final entry forever. */
function scripted<TValue>(values: readonly TValue[]): {
  read: () => Promise<TValue>;
  count: () => number;
} {
  let index = 0;
  return {
    read: async () => {
      const value = values[Math.min(index, values.length - 1)]!;
      index += 1;
      return value;
    },
    count: () => index,
  };
}

function options<TValue>(
  clock: ReturnType<typeof fakeClock>,
  overrides: Partial<StabilityOptions<TValue>> = {},
): StabilityOptions<TValue> {
  return {
    quietPolls: 2,
    pollMs: 100,
    deadlineMs: 3_000,
    now: clock.now,
    sleep: clock.sleep,
    ...overrides,
  };
}

const join = (value: readonly string[]): string => value.join('|');

describe('@no-llm readWhenStable', () => {
  it('settles once the value repeats for the required number of polls', async () => {
    const clock = fakeClock();
    const source = scripted([['a'], ['a', 'b'], ['a', 'b']]);

    const result = await readWhenStable(source.read, join, options<readonly string[]>(clock));

    expect(result.stable).toBe(true);
    expect(result.value).toEqual(['a', 'b']);
    expect(result.reads).toBe(3);
  });

  it('ranks the settled list rather than the one still churning', async () => {
    const clock = fakeClock();
    // The shape that made typing an airport code offer the wrong city: the
    // popup shows results for the earlier keystrokes before the real answer.
    const source = scripted([['Fort Wayne'], ['Dallas Love Field'], ['Dallas'], ['Dallas']]);

    const result = await readWhenStable(source.read, join, options<readonly string[]>(clock));

    expect(result.stable).toBe(true);
    expect(result.value).toEqual(['Dallas']);
  });

  it('returns the last read unstable when the value never settles', async () => {
    const clock = fakeClock();
    let counter = 0;
    const read = async (): Promise<readonly string[]> => [`v${(counter += 1)}`];

    const result = await readWhenStable(read, join, options<readonly string[]>(clock));

    expect(result.stable).toBe(false);
    expect(result.value).toHaveLength(1);
    expect(result.reads).toBeGreaterThan(1);
  });

  it('keeps polling past an empty-but-stable value when accept rejects it', async () => {
    const clock = fakeClock();
    // Two empty reads are perfectly stable and completely useless; without
    // `accept` this would settle immediately and never see the suggestions.
    const source = scripted([[], [], ['Dallas'], ['Dallas']]);

    const result = await readWhenStable(
      source.read,
      join,
      options<readonly string[]>(clock, { accept: (value) => value.length > 0 }),
    );

    expect(result.stable).toBe(true);
    expect(result.value).toEqual(['Dallas']);
  });

  it('reads a list that only arrives well past a fixed short wait', async () => {
    const clock = fakeClock();
    const late: readonly string[][] = [[], [], [], [], [], [], [], [], [], [], ['SJC'], ['SJC']];
    const source = scripted(late);

    const result = await readWhenStable(
      source.read,
      join,
      options<readonly string[]>(clock, {
        pollMs: 250,
        deadlineMs: 8_000,
        accept: (v) => v.length > 0,
      }),
    );

    expect(result.stable).toBe(true);
    expect(result.value).toEqual(['SJC']);
  });

  it('respects minReads even when the first two reads already agree', async () => {
    const clock = fakeClock();
    const source = scripted([['a'], ['a'], ['a'], ['a']]);

    const result = await readWhenStable(
      source.read,
      join,
      options<readonly string[]>(clock, { minReads: 4 }),
    );

    expect(result.reads).toBe(4);
    expect(result.stable).toBe(true);
  });

  it('restarts the quiet count when the value changes', async () => {
    const clock = fakeClock();
    const source = scripted([['a'], ['a'], ['b'], ['b'], ['b']]);

    const result = await readWhenStable(
      source.read,
      join,
      options<readonly string[]>(clock, { quietPolls: 3 }),
    );

    expect(result.value).toEqual(['b']);
    expect(result.reads).toBe(5);
  });

  it('takes at least one read even with a deadline already passed', async () => {
    const clock = fakeClock();
    const source = scripted([['a']]);

    const result = await readWhenStable(
      source.read,
      join,
      options<readonly string[]>(clock, { deadlineMs: -1 }),
    );

    expect(result.reads).toBe(1);
    expect(result.stable).toBe(false);
    expect(result.value).toEqual(['a']);
  });

  it('treats quietPolls below one as a single read', async () => {
    const clock = fakeClock();
    const source = scripted([['a'], ['b']]);

    const result = await readWhenStable(
      source.read,
      join,
      options<readonly string[]>(clock, { quietPolls: 0 }),
    );

    expect(result.reads).toBe(1);
    expect(result.stable).toBe(true);
  });
});
