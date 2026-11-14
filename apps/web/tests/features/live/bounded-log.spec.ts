import { describe, expect, it } from 'vitest';

import {
  LOG_CHUNK,
  appendLog,
  emptyLog,
  firstIndex,
  logAt,
  logEntries,
  replaceLog,
  type BoundedLog,
} from '../../../src/features/live/bounded-log.js';

function fill(cap: number, count: number): BoundedLog<number> {
  let log = emptyLog<number>(cap);
  for (let index = 0; index < count; index += 1) log = appendLog(log, index);
  return log;
}

describe('@no-llm bounded log', () => {
  it('keeps every entry below the cap, oldest first', () => {
    const log = fill(10, 4);

    expect(logEntries(log)).toEqual([0, 1, 2, 3]);
    expect(log.size).toBe(4);
    expect(log.total).toBe(4);
    expect(firstIndex(log)).toBe(0);
  });

  it('drops the oldest entries past the cap and counts every append', () => {
    const log = fill(100, 1_000);

    expect(log.size).toBe(100);
    expect(log.total).toBe(1_000);
    expect(logEntries(log)[0]).toBe(900);
    expect(logEntries(log).at(-1)).toBe(999);
    expect(firstIndex(log)).toBe(900);
  });

  it('holds a cap that is not a multiple of the chunk size exactly', () => {
    const cap = LOG_CHUNK * 3 + 7;
    const log = fill(cap, cap * 5 + 3);

    expect(logEntries(log)).toHaveLength(cap);
    expect(logEntries(log)).toEqual(Array.from({ length: cap }, (_, i) => cap * 4 + 3 + i));
  });

  it('never mutates the log it was given', () => {
    const before = fill(5, 5);
    const snapshot = [...logEntries(before)];

    appendLog(before, 99);
    replaceLog(before, 2, 42);

    expect(logEntries(before)).toEqual(snapshot);
  });

  it('reads and replaces by absolute index, and ignores dropped ones', () => {
    const log = fill(3, 5);

    expect(logAt(log, 1)).toBeUndefined();
    expect(logAt(log, 4)).toBe(4);
    expect(logAt(log, 5)).toBeUndefined();
    expect(logEntries(replaceLog(log, 3, 30))).toEqual([2, 30, 4]);
    expect(replaceLog(log, 0, 7)).toBe(log);
    expect(replaceLog(log, -1, 7)).toBe(log);
  });

  it('memoizes the flattened entries per version', () => {
    const log = fill(10, 3);

    expect(logEntries(log)).toBe(logEntries(log));
    expect(logEntries(appendLog(log, 3))).not.toBe(logEntries(log));
  });

  it('refuses a cap below one', () => {
    expect(() => emptyLog(0)).toThrow(RangeError);
    expect(() => emptyLog(1.5)).toThrow(RangeError);
  });

  it('copies at most one chunk per append', () => {
    const log = fill(2_000, 2_000);
    const next = appendLog(log, 2_000);
    const shared = next.chunks.filter((chunk) => log.chunks.includes(chunk)).length;

    expect(shared).toBeGreaterThanOrEqual(next.chunks.length - 2);
  });
});
