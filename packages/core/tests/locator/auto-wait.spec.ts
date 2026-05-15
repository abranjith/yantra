import type { ElementHandle } from 'puppeteer-core';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { resolveActionable } from '../../src/locator/auto-wait.js';
import {
  LocatorAmbiguousError,
  LocatorNotActionableError,
  FrameDetachedError,
} from '../../src/locator/errors.js';
import type {
  ActionableState,
  EngineLocatorChain,
  InjectedScriptHost,
} from '../../src/locator/types.js';

function makeFakeHandle(): ElementHandle {
  return { _fake: true } as unknown as ElementHandle;
}

function makeChain(name = 'Test element'): EngineLocatorChain {
  return {
    name,
    candidates: [{ intent: { kind: 'css', selector: 'button' }, source: 'authored' }],
    strict: true,
  };
}

function makeActionableState(overrides: Partial<ActionableState> = {}): ActionableState {
  return {
    visible: true,
    enabled: true,
    stable: true,
    receivesEvents: true,
    attached: true,
    ...overrides,
  };
}

/** Creates a host that returns a successful resolve after `afterCallN` calls. */
function makeHost(
  opts: {
    resolveResults?: { count: number; slotKey?: string }[];
    actionableStates?: ActionableState[];
    handle?: ElementHandle | null;
  } = {},
): InjectedScriptHost {
  const resolveResults = opts.resolveResults ?? [{ count: 1, slotKey: 'default' }];
  const actionableStates = opts.actionableStates ?? [makeActionableState()];
  const handle = opts.handle ?? makeFakeHandle();

  let resolveIdx = 0;
  let actionableIdx = 0;

  return {
    ensureInjected: vi.fn().mockResolvedValue(undefined),
    call: vi.fn().mockImplementation(async (_frameId: string, fn: string) => {
      if (fn === 'resolveCandidate') {
        const result = resolveResults[resolveIdx] ?? resolveResults.at(-1) ?? { count: 0 };
        resolveIdx++;
        return result;
      }
      if (fn === 'checkActionableState') {
        const state =
          actionableStates[actionableIdx] ?? actionableStates.at(-1) ?? makeActionableState();
        actionableIdx++;
        return state;
      }
      if (fn === 'getBoundingRect') {
        return { top: 10, left: 10, width: 100, height: 40 };
      }
      if (fn === 'clearSlot') {
        return undefined;
      }
      return undefined;
    }),
    callHandle: vi.fn().mockResolvedValue(handle),
  };
}

describe('@no-llm resolveActionable', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns immediately when element is actionable on first poll', async () => {
    const host = makeHost();
    const chain = makeChain();

    const resultPromise = resolveActionable(chain, host, { timeoutMs: 5000 });
    // Advance timers past the first 0ms delay
    await vi.runAllTimersAsync();

    const result = await resultPromise;
    expect(result.kind).toBe('success');
    expect(result.usedCandidateIndex).toBe(0);
  });

  it('throws LocatorAmbiguousError immediately when candidate is ambiguous', async () => {
    const host = makeHost({
      resolveResults: [{ count: 3 }], // ambiguous
    });
    const chain = makeChain();

    const resultPromise = resolveActionable(chain, host, { timeoutMs: 5000 });
    // Suppress the unhandled-rejection warning that Node.js emits while timers run
    // before we attach the .rejects handler below.
    void resultPromise.catch(() => undefined);
    await vi.runAllTimersAsync();

    await expect(resultPromise).rejects.toThrow(LocatorAmbiguousError);
  });

  it('throws FrameDetachedError when frame detaches', async () => {
    const frameError = new Error('frame was detached');
    frameError.name = 'FrameDetachedError';

    const host: InjectedScriptHost = {
      ensureInjected: vi.fn().mockResolvedValue(undefined),
      call: vi.fn().mockRejectedValue(frameError),
      callHandle: vi.fn().mockResolvedValue(null),
    };
    const chain = makeChain();

    const resultPromise = resolveActionable(chain, host, { timeoutMs: 5000 });
    void resultPromise.catch(() => undefined);
    await vi.runAllTimersAsync();

    await expect(resultPromise).rejects.toThrow(FrameDetachedError);
  });

  it('throws LocatorNotActionableError when deadline passes before actionable', async () => {
    const notActionable = makeActionableState({ visible: false });
    const host = makeHost({
      resolveResults: [{ count: 1, slotKey: 'default' }],
      actionableStates: [notActionable],
    });
    const chain = makeChain();

    const resultPromise = resolveActionable(chain, host, { timeoutMs: 100 });
    void resultPromise.catch(() => undefined);

    // Advance time past the deadline
    await vi.advanceTimersByTimeAsync(200);

    await expect(resultPromise).rejects.toThrow(LocatorNotActionableError);
  });

  it('polls until element becomes actionable', async () => {
    // First two polls: not found; third poll: found and actionable
    const host = makeHost({
      resolveResults: [{ count: 0 }, { count: 0 }, { count: 1, slotKey: 'default' }],
      actionableStates: [makeActionableState()],
    });
    const chain = makeChain();

    const resultPromise = resolveActionable(chain, host, { timeoutMs: 30_000 });
    await vi.runAllTimersAsync();

    const result = await resultPromise;
    expect(result.kind).toBe('success');
  });
});
