import type { Page } from 'puppeteer-core';
import { describe, expect, it, vi } from 'vitest';

import { AgentBrowserController } from '../../src/browser/agent-controller.js';
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

  it('uses a page-scoped screenshot session, preserves viewport, and detaches it', async () => {
    const { controller, cdp, page } = screenshotHarness();

    await expect(controller.capturePng()).resolves.toMatchObject({ width: 1, height: 1 });
    expect(page.createCDPSession).toHaveBeenCalledTimes(1);
    expect(cdp.send).toHaveBeenCalledWith(
      'Page.captureScreenshot',
      expect.objectContaining({ clip: { x: 0, y: 0, width: 800, height: 600, scale: 1 } }),
    );
    expect(cdp.detach).toHaveBeenCalledTimes(1);
    expect((page as unknown as { setViewport?: unknown }).setViewport).toBeUndefined();
  });

  it('detaches the page-scoped session and removes marks when screenshot CDP fails', async () => {
    const failure = new Error('capture transport failed');
    const { controller, cdp, page } = screenshotHarness(failure);

    await expect(controller.capturePng()).rejects.toBe(failure);
    expect(cdp.detach).toHaveBeenCalledTimes(1);
    expect(page.evaluate).toHaveBeenCalledWith(expect.any(Function), '__yantra_set_of_marks__');
  });
});

const ONE_PIXEL_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lr6fWQAAAABJRU5ErkJggg==';

function screenshotHarness(captureError?: Error) {
  const cdp = {
    send: captureError
      ? vi.fn().mockRejectedValue(captureError)
      : vi.fn().mockResolvedValue({ data: ONE_PIXEL_PNG }),
    detach: vi.fn(async () => undefined),
  };
  const page = {
    evaluate: vi.fn(async (fn: (...args: unknown[]) => unknown, ...args: unknown[]) => {
      if (args.length === 0) return { width: 800, height: 600 };
      if (String(fn).includes('!== null')) return false;
      return undefined;
    }),
    createCDPSession: vi.fn(async () => cdp),
  } as unknown as Page & {
    evaluate: ReturnType<typeof vi.fn>;
    createCDPSession: ReturnType<typeof vi.fn>;
  };
  const controller = new AgentBrowserController({
    runId: 'screenshot-migration',
    browserProvider: {} as never,
  });
  const internals = controller as unknown as {
    session: object;
    pageFacade: object;
    page: Page;
    settler: { epoch: number };
  };
  internals.session = {};
  internals.pageFacade = {};
  internals.page = page;
  internals.settler = { epoch: 1 };
  return { controller, cdp, page };
}
