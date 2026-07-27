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

  it('throws LocatorAmbiguousError when a candidate stays ambiguous through the deadline', async () => {
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

  it('keeps polling through a transient ambiguity and succeeds once the duplicate goes away', async () => {
    // A mid-render page routinely shows a skeleton row beside its loaded
    // replacement. Failing the instant that happens made a self-healing page
    // state fatal.
    const handle = makeFakeHandle();
    const host = makeHost({
      resolveResults: [{ count: 2 }, { count: 2 }, { count: 1, slotKey: 'default' }],
      handle,
    });
    const chain = makeChain();

    const resultPromise = resolveActionable(chain, host, { timeoutMs: 5000 });
    await vi.runAllTimersAsync();

    const result = await resultPromise;
    expect(result.kind).toBe('success');
    expect(result.elementHandle).toBe(handle);
  });

  it('resolves a read-only locator whose centre never wins the hit test', async () => {
    // Regression: `receivesEvents` hit-tests the element's centre against the
    // viewport, so `body` on any page taller than one screen — the locator that
    // `do --save-as` records for an extract step — can never satisfy it. Under
    // the default `actionable` requirement that step burned its whole deadline
    // and reported "locator not found" on a page that was perfectly fine.
    const handle = makeFakeHandle();
    const host = makeHost({
      actionableStates: [makeActionableState({ receivesEvents: false })],
      handle,
    });
    const chain = makeChain('body');

    const resultPromise = resolveActionable(chain, host, {
      timeoutMs: 5000,
      requirement: 'visible',
    });
    await vi.runAllTimersAsync();

    const result = await resultPromise;
    expect(result.kind).toBe('success');
    expect(result.elementHandle).toBe(handle);
  });

  it('still refuses to click an element whose centre never wins the hit test', async () => {
    // The mirror of the previous test: relaxing reads must not relax clicks.
    const host = makeHost({
      actionableStates: [makeActionableState({ receivesEvents: false })],
    });
    const chain = makeChain();

    const resultPromise = resolveActionable(chain, host, {
      timeoutMs: 5000,
      requirement: 'actionable',
    });
    void resultPromise.catch(() => undefined);
    await vi.runAllTimersAsync();

    await expect(resultPromise).rejects.toThrow(LocatorNotActionableError);
  });

  it('defaults to the full actionable contract when no requirement is given', async () => {
    const host = makeHost({
      actionableStates: [makeActionableState({ receivesEvents: false })],
    });

    const resultPromise = resolveActionable(makeChain(), host, { timeoutMs: 5000 });
    void resultPromise.catch(() => undefined);
    await vi.runAllTimersAsync();

    await expect(resultPromise).rejects.toThrow(LocatorNotActionableError);
  });

  it('satisfies the attached requirement for an element that is present but hidden', async () => {
    // `wait_for: attached` must not secretly demand visibility.
    const handle = makeFakeHandle();
    const host = makeHost({
      actionableStates: [
        makeActionableState({ visible: false, receivesEvents: false, attached: true }),
      ],
      handle,
    });

    const resultPromise = resolveActionable(makeChain(), host, {
      timeoutMs: 5000,
      requirement: 'attached',
    });
    await vi.runAllTimersAsync();

    const result = await resultPromise;
    expect(result.kind).toBe('success');
    expect(result.elementHandle).toBe(handle);
  });

  it('rejects a detached element even under the attached requirement', async () => {
    const host = makeHost({
      actionableStates: [makeActionableState({ attached: false })],
    });

    const resultPromise = resolveActionable(makeChain(), host, {
      timeoutMs: 5000,
      requirement: 'attached',
    });
    void resultPromise.catch(() => undefined);
    await vi.runAllTimersAsync();

    await expect(resultPromise).rejects.toThrow(LocatorNotActionableError);
  });

  it('still requires visibility and enablement under the visible requirement', async () => {
    const host = makeHost({
      actionableStates: [makeActionableState({ visible: true, enabled: false })],
    });

    const resultPromise = resolveActionable(makeChain(), host, {
      timeoutMs: 5000,
      requirement: 'visible',
    });
    void resultPromise.catch(() => undefined);
    await vi.runAllTimersAsync();

    await expect(resultPromise).rejects.toThrow(LocatorNotActionableError);
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

  // ── Regression: navigation race after a preceding click/navigate ──────────
  // A step that triggers navigation (e.g. a Login-button click) leaves the page
  // tearing down its old document. The next step's resolution then races that
  // navigation and the injected-script call throws "Execution context was
  // destroyed" (bare, or wrapped by the injection host). These must be treated
  // as transient and polled through — not surfaced as a fatal `unexpected`.

  it('retries a transient navigation error thrown while resolving and succeeds once the page settles', async () => {
    // ensureInjected throws a wrapped navigation error on the first poll (the
    // old document is being destroyed), then succeeds once the new doc loads.
    let ensureCalls = 0;
    const navError = new Error(
      'Unable to inject locator runtime into frame "main": Execution context was destroyed, most likely because of a navigation.',
    );
    const host: InjectedScriptHost = {
      ensureInjected: vi.fn().mockImplementation(async () => {
        ensureCalls += 1;
        if (ensureCalls === 1) throw navError;
      }),
      call: vi.fn().mockImplementation(async (_frameId: string, fn: string) => {
        if (fn === 'resolveCandidate') return { count: 1, slotKey: 'default' };
        if (fn === 'checkActionableState') return makeActionableState();
        if (fn === 'getBoundingRect') return { top: 10, left: 10, width: 100, height: 40 };
        return undefined;
      }),
      callHandle: vi.fn().mockResolvedValue(makeFakeHandle()),
    };
    const chain = makeChain();

    const resultPromise = resolveActionable(chain, host, { timeoutMs: 30_000 });
    await vi.runAllTimersAsync();

    const result = await resultPromise;
    expect(result.kind).toBe('success');
    expect(ensureCalls).toBeGreaterThan(1); // proves it retried past the nav error
  });

  it('retries a transient navigation error thrown during the actionability check', async () => {
    let stateCalls = 0;
    const navError = new Error(
      'Execution context was destroyed, most likely because of a navigation.',
    );
    const host: InjectedScriptHost = {
      ensureInjected: vi.fn().mockResolvedValue(undefined),
      call: vi.fn().mockImplementation(async (_frameId: string, fn: string) => {
        if (fn === 'resolveCandidate') return { count: 1, slotKey: 'default' };
        if (fn === 'checkActionableState') {
          stateCalls += 1;
          if (stateCalls === 1) throw navError;
          return makeActionableState();
        }
        if (fn === 'getBoundingRect') return { top: 10, left: 10, width: 100, height: 40 };
        return undefined;
      }),
      callHandle: vi.fn().mockResolvedValue(makeFakeHandle()),
    };
    const chain = makeChain();

    const resultPromise = resolveActionable(chain, host, { timeoutMs: 30_000 });
    await vi.runAllTimersAsync();

    const result = await resultPromise;
    expect(result.kind).toBe('success');
    expect(stateCalls).toBeGreaterThan(1);
  });

  it('propagates a non-transient error instead of retrying it', async () => {
    // "Target closed" is a genuinely fatal condition — it must not be mistaken
    // for a recoverable navigation race and polled until the deadline.
    const fatal = new Error('Target closed');
    const host: InjectedScriptHost = {
      ensureInjected: vi.fn().mockRejectedValue(fatal),
      call: vi.fn().mockResolvedValue(undefined),
      callHandle: vi.fn().mockResolvedValue(null),
    };
    const chain = makeChain();

    const resultPromise = resolveActionable(chain, host, { timeoutMs: 5_000 });
    void resultPromise.catch(() => undefined);
    await vi.runAllTimersAsync();

    await expect(resultPromise).rejects.toThrow('Target closed');
  });
});
