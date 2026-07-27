/**
 * Settling wrappers — ordering guarantees and graceful degradation.
 *
 * Settling was added to every mutating step, so the wrappers must be inert for
 * contexts that have no Puppeteer page (test fakes, non-Puppeteer providers).
 * If they were not, adding settling would have broken every existing handler
 * test rather than only slowing real runs down.
 */

import { describe, expect, it, vi } from 'vitest';

import type { PageSettler } from '../../../src/browser/page-settle.js';
import {
  settleAfterNavigation,
  settleBeforeRead,
  withPageSettling,
} from '../../../src/executor/step-handlers/settle-helpers.js';
import type { ExecutionContext } from '../../../src/executor/types.js';

function makeSettler(): PageSettler & {
  watch: ReturnType<typeof vi.fn>;
  settleAfterAction: ReturnType<typeof vi.fn>;
  settleBeforeRead: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
} {
  const watchHandle = { dispose: vi.fn() };
  return {
    watch: vi.fn(() => watchHandle),
    settleAfterAction: vi.fn(async () => undefined),
    settleBeforeRead: vi.fn(async () => undefined),
    awaitCommit: vi.fn(async () => false),
    awaitDomReady: vi.fn(async () => undefined),
    awaitNetworkQuiet: vi.fn(async () => undefined),
    dispose: vi.fn(),
    epoch: 0,
  } as unknown as PageSettler & {
    watch: ReturnType<typeof vi.fn>;
    settleAfterAction: ReturnType<typeof vi.fn>;
    settleBeforeRead: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  };
}

function makeCtx(settler: PageSettler | null): ExecutionContext {
  return { settler } as unknown as ExecutionContext;
}

describe('@no-llm withPageSettling', () => {
  it('installs the navigation watch before the action runs', async () => {
    // A navigation the site starts synchronously in its click handler would
    // slip through a watch installed afterwards.
    const settler = makeSettler();
    const order: string[] = [];
    settler.watch.mockImplementation(() => {
      order.push('watch');
      return { dispose: vi.fn() };
    });

    await withPageSettling(makeCtx(settler), 800, () => {
      order.push('action');
      return Promise.resolve('done');
    });

    expect(order).toEqual(['watch', 'action']);
  });

  it('settles after the action and returns its value', async () => {
    const settler = makeSettler();

    const result = await withPageSettling(makeCtx(settler), 800, () => Promise.resolve('clicked'));

    expect(result).toBe('clicked');
    expect(settler.settleAfterAction).toHaveBeenCalledTimes(1);
    expect(settler.settleAfterAction.mock.calls[0]?.[1]).toBe(800);
  });

  it('disposes the watch even when the action throws', async () => {
    // The watch adds page listeners; leaking one per failed step would
    // accumulate over a long run.
    const settler = makeSettler();
    const watchHandle = { dispose: vi.fn() };
    settler.watch.mockReturnValue(watchHandle);

    await expect(
      withPageSettling(makeCtx(settler), 800, () => Promise.reject(new Error('click failed'))),
    ).rejects.toThrow('click failed');

    expect(watchHandle.dispose).toHaveBeenCalledTimes(1);
    expect(settler.settleAfterAction).not.toHaveBeenCalled();
  });

  it('runs the action directly when the context has no settler', async () => {
    const action = vi.fn(async () => 'done');

    await expect(withPageSettling(makeCtx(null), 800, action)).resolves.toBe('done');

    expect(action).toHaveBeenCalledTimes(1);
  });
});

describe('@no-llm settleAfterNavigation', () => {
  it('settles and disposes its watch', async () => {
    const settler = makeSettler();
    const watchHandle = { dispose: vi.fn() };
    settler.watch.mockReturnValue(watchHandle);

    await settleAfterNavigation(makeCtx(settler));

    expect(settler.settleAfterAction).toHaveBeenCalledTimes(1);
    expect(watchHandle.dispose).toHaveBeenCalledTimes(1);
  });

  it('is a no-op without a settler', async () => {
    await expect(settleAfterNavigation(makeCtx(null))).resolves.toBeUndefined();
  });
});

describe('@no-llm settleBeforeRead', () => {
  it('delegates to the settler', async () => {
    const settler = makeSettler();

    await settleBeforeRead(makeCtx(settler));

    expect(settler.settleBeforeRead).toHaveBeenCalledTimes(1);
  });

  it('is a no-op without a settler', async () => {
    await expect(settleBeforeRead(makeCtx(null))).resolves.toBeUndefined();
  });
});
