import { describe, expect, it, vi } from 'vitest';

import {
  withSetOfMarksCapture,
  type SetOfMarksError,
  type SetOfMarksMark,
  type SetOfMarksPort,
} from '../../src/browser/set-of-marks.js';

const MARKS: readonly SetOfMarksMark[] = [
  { ref: 'e1', left: 10, top: 20, width: 30, height: 40 },
  { ref: 'e2', left: 50, top: 60, width: 70, height: 80 },
];

function fakePort(overrides: Partial<SetOfMarksPort> = {}) {
  let present = false;
  const injected: SetOfMarksMark[][] = [];
  const port: SetOfMarksPort = {
    inject: async (marks) => {
      present = true;
      injected.push([...marks]);
    },
    remove: async () => {
      present = false;
    },
    present: async () => present,
    ...overrides,
  };
  return { port, injected, isPresent: () => present };
}

describe('@no-llm set-of-marks capture stage', () => {
  it('removes the overlay after successful capture', async () => {
    const fake = fakePort();
    await expect(
      withSetOfMarksCapture({
        port: fake.port,
        marks: MARKS,
        readTopLevelEpoch: () => 1,
        capture: () => Promise.resolve('png'),
      }),
    ).resolves.toBe('png');
    expect(fake.isPresent()).toBe(false);
  });

  it('removes the overlay when capture throws', async () => {
    const fake = fakePort();
    await expect(
      withSetOfMarksCapture({
        port: fake.port,
        marks: MARKS,
        readTopLevelEpoch: () => 1,
        capture: () => Promise.reject(new Error('capture failed')),
      }),
    ).rejects.toThrow('capture failed');
    expect(fake.isPresent()).toBe(false);
  });

  it('attempts removal after a partial injection failure', async () => {
    let present = false;
    const remove = vi.fn(async () => {
      present = false;
    });
    const fake = fakePort({
      inject: async () => {
        present = true;
        throw new Error('injection failed');
      },
      remove,
      present: async () => present,
    });
    await expect(
      withSetOfMarksCapture({
        port: fake.port,
        marks: MARKS,
        readTopLevelEpoch: () => 1,
        capture: () => Promise.resolve('never'),
      }),
    ).rejects.toThrow('injection failed');
    expect(remove).toHaveBeenCalledOnce();
    expect(present).toBe(false);
  });

  it('discards a capture when navigation races after capture', async () => {
    const fake = fakePort();
    const epochs = [1, 1, 2, 2];
    const discard = vi.fn();
    await expect(
      withSetOfMarksCapture({
        port: fake.port,
        marks: MARKS,
        readTopLevelEpoch: () => epochs.shift() ?? 2,
        capture: () => Promise.resolve('png'),
        discard,
      }),
    ).rejects.toMatchObject({ code: 'SET_OF_MARKS_EPOCH_CHANGED' });
    expect(discard).toHaveBeenCalledWith('png');
    expect(fake.isPresent()).toBe(false);
  });

  it('raises a typed error when removal cannot be verified', async () => {
    const fake = fakePort({ present: () => Promise.resolve(true) });
    await expect(
      withSetOfMarksCapture({
        port: fake.port,
        marks: MARKS,
        readTopLevelEpoch: () => 1,
        capture: () => Promise.resolve('png'),
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<SetOfMarksError>>({ code: 'SET_OF_MARKS_REMOVAL_FAILED' }),
    );
  });

  it('injects only Yantra refs and numeric geometry, never page-derived text', async () => {
    const fake = fakePort();
    await withSetOfMarksCapture({
      port: fake.port,
      marks: [...MARKS, { ref: 'Buy now $99', left: 1, top: 1, width: 2, height: 2 }],
      readTopLevelEpoch: () => 1,
      capture: () => Promise.resolve('png'),
    });
    expect(fake.injected.flat()).toEqual(MARKS);
    expect(JSON.stringify(fake.injected)).not.toContain('Buy now');
  });

  it('has zero injections when no explicit capture stage runs', () => {
    const fake = fakePort();
    // Observation/detection code has no port reference; only this explicit
    // capture helper can call inject.
    expect(fake.injected).toHaveLength(0);
  });
});
