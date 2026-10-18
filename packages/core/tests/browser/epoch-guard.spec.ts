import { describe, expect, it, vi } from 'vitest';

import {
  assertEpochUnchanged,
  readInitialEpoch,
  SetOfMarksError,
  withEpochGuardedCapture,
} from '../../src/browser/epoch-guard.js';
import { SetOfMarksError as ReexportedError } from '../../src/browser/set-of-marks.js';

/** An epoch reader that returns each value in turn, then repeats the last. */
function epochs(...values: (number | null)[]): () => number | null {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)] ?? null;
}

describe('@no-llm epoch-guarded capture', () => {
  it('returns the capture when the epoch is unchanged', async () => {
    const capture = vi.fn(async () => 'png');

    await expect(
      withEpochGuardedCapture({ readTopLevelEpoch: epochs(4, 4), capture }),
    ).resolves.toBe('png');
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it('throws and discards the capture when the epoch changes during capture', async () => {
    const result = withEpochGuardedCapture({
      readTopLevelEpoch: epochs(4, 5),
      capture: async () => 'png',
    });

    await expect(result).rejects.toBeInstanceOf(SetOfMarksError);
    await expect(result).rejects.toMatchObject({ code: 'SET_OF_MARKS_EPOCH_CHANGED' });
  });

  it.each([
    ['null', null],
    ['negative', -1],
    ['fractional', 1.5],
  ])('throws before capturing when the epoch is %s', async (_label, epoch) => {
    const capture = vi.fn(async () => 'png');

    await expect(
      withEpochGuardedCapture({ readTopLevelEpoch: () => epoch, capture }),
    ).rejects.toMatchObject({ code: 'SET_OF_MARKS_EPOCH_CHANGED' });
    expect(capture).not.toHaveBeenCalled();
  });

  it('throws when the epoch becomes unreadable after capture', async () => {
    await expect(
      withEpochGuardedCapture({ readTopLevelEpoch: epochs(2, null), capture: async () => 1 }),
    ).rejects.toMatchObject({ code: 'SET_OF_MARKS_EPOCH_CHANGED' });
  });

  it('propagates a capture failure unchanged', async () => {
    const failure = new Error('transport failed');

    await expect(
      withEpochGuardedCapture({
        readTopLevelEpoch: () => 1,
        capture: async () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
  });

  it('accepts epoch zero', () => {
    expect(readInitialEpoch(() => 0)).toBe(0);
  });

  it('names the stage in the epoch-changed message', () => {
    expect(() => assertEpochUnchanged(3, 2, 'before capture')).toThrow(/changed before capture/);
    expect(() => assertEpochUnchanged(2, 2, 'before capture')).not.toThrow();
  });

  it('keeps one error class for every import site', () => {
    expect(ReexportedError).toBe(SetOfMarksError);
  });
});
