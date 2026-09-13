// @no-llm
import { EventEmitter } from 'node:events';

import type { CDPSession } from 'puppeteer-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PopupHandler,
  type PopupHandlerCallbacks,
  type PopupHandlerEvent,
} from '../../../src/workflow/recorder/popup-handler.js';

describe('@no-llm recorder popup session ownership', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(['before', 'after'] as const)(
    'uses the exact public child session when attachment is visible %s the response',
    async (ordering) => {
      const child = new FakeSession('child-session');
      const browser = new FakeSession('browser-session');
      browser.onAttach = async (targetId) => {
        if (ordering === 'before') browser.registry.set(child.id(), child);
        browser.emit('Target.attachedToTarget', {
          sessionId: child.id(),
          targetInfo: { targetId },
        });
        if (ordering === 'after') queueMicrotask(() => browser.registry.set(child.id(), child));
        return child.id();
      };
      const harness = recorderHarness(browser);
      await harness.handler.install();

      browser.emit('Target.targetCreated', target('popup', 'main'));
      await waitFor(() => harness.events.some((event) => event.kind === 'popup_attached'));

      expect(harness.instrument).toHaveBeenCalledWith(child, 'popup');
      expect(harness.instrument).not.toHaveBeenCalledWith(browser, 'popup');
      expect(harness.handler.popups.get('popup')).toMatchObject({
        sessionId: 'child-session',
        state: 'ready',
      });
      expect(browser.commands.every(([method]) => method.startsWith('Target.'))).toBe(true);
      await harness.handler.dispose();
    },
  );

  it('waits for the public registry and ignores unrelated attachment events', async () => {
    const child = new FakeSession('child-session');
    const browser = new FakeSession('browser-session');
    browser.onAttach = async (targetId) => {
      browser.emit('Target.attachedToTarget', {
        sessionId: 'unrelated-session',
        targetInfo: { targetId: 'unrelated-target' },
      });
      setTimeout(() => {
        browser.registry.set(child.id(), child);
        browser.emit('Target.attachedToTarget', {
          sessionId: child.id(),
          targetInfo: { targetId },
        });
      }, 5);
      return child.id();
    };
    const harness = recorderHarness(browser);
    await harness.handler.install();

    browser.emit('Target.targetCreated', target('popup', 'main'));
    await waitFor(() => harness.instrument.mock.calls.length === 1);

    expect(harness.instrument).toHaveBeenCalledWith(child, 'popup');
    await harness.handler.dispose();
  });

  it('times out without substituting the browser session', async () => {
    const browser = new FakeSession('browser-session');
    browser.onAttach = async () => 'missing-session';
    const harness = recorderHarness(browser, { attachmentTimeoutMs: 10 });
    await harness.handler.install();

    browser.emit('Target.targetCreated', target('popup', 'main'));
    await waitFor(() => harness.events.some((event) => event.kind === 'recording_degraded'));

    expect(harness.instrument).not.toHaveBeenCalled();
    expect(harness.handler.popups.size).toBe(0);
    expect(browser.commands).toContainEqual([
      'Target.attachToTarget',
      { targetId: 'popup', flatten: true },
    ]);
    await harness.handler.dispose();
  });

  it('rejects a target/session mismatch before instrumentation', async () => {
    const browser = new FakeSession('browser-session');
    browser.onAttach = async (targetId) => {
      browser.emit('Target.attachedToTarget', {
        sessionId: 'wrong-session',
        targetInfo: { targetId },
      });
      return 'expected-session';
    };
    const harness = recorderHarness(browser);
    await harness.handler.install();

    browser.emit('Target.targetCreated', target('popup', 'main'));
    await waitFor(() => harness.events.some((event) => event.kind === 'recording_degraded'));

    expect(harness.instrument).not.toHaveBeenCalled();
    expect(harness.events.find((event) => event.kind === 'recording_degraded')).toMatchObject({
      reason: expect.stringContaining('identity mismatch'),
    });
    await harness.handler.dispose();
  });

  it('deduplicates target events and admits a grandchild while its parent is pending', async () => {
    const parent = new FakeSession('parent-session');
    const child = new FakeSession('child-session');
    const browser = new FakeSession('browser-session');
    browser.onAttach = async (targetId) => {
      const session = targetId === 'parent' ? parent : child;
      setTimeout(() => {
        browser.registry.set(session.id(), session);
        browser.emit('Target.attachedToTarget', {
          sessionId: session.id(),
          targetInfo: { targetId },
        });
      }, 5);
      return session.id();
    };
    const harness = recorderHarness(browser);
    await harness.handler.install();

    browser.emit('Target.targetCreated', target('parent', 'main'));
    browser.emit('Target.targetCreated', target('parent', 'main'));
    browser.emit('Target.targetCreated', target('child', 'parent'));
    await waitFor(() => harness.instrument.mock.calls.length === 2);

    expect(browser.commands.filter(([method]) => method === 'Target.attachToTarget')).toHaveLength(
      2,
    );
    expect(harness.handler.popups.get('child')?.parentTargetId).toBe('parent');
    await harness.handler.dispose();
  });

  it('cancels a destroyed target and cleans up failed overlay instrumentation', async () => {
    const child = new FakeSession('child-session');
    const browser = new FakeSession('browser-session');
    browser.onAttach = async () => {
      browser.registry.set(child.id(), child);
      return child.id();
    };
    const harness = recorderHarness(browser, {
      instrument: vi.fn().mockRejectedValue(new Error('overlay rejected')),
    });
    await harness.handler.install();

    browser.emit('Target.targetCreated', target('popup', 'main'));
    await waitFor(() => harness.events.some((event) => event.kind === 'recording_degraded'));

    expect(harness.closed).toHaveBeenCalledWith(child, 'popup');
    expect(browser.commands).toContainEqual(['Target.detachFromTarget', { sessionId: child.id() }]);
    expect(harness.events.some((event) => event.kind === 'popup_attached')).toBe(false);
    await harness.handler.dispose();
    await harness.handler.dispose();
  });

  it('cancels pending work on target destruction and transport disconnection', async () => {
    const browser = new FakeSession('browser-session');
    browser.onAttach = async () => 'pending-session';
    const harness = recorderHarness(browser, { attachmentTimeoutMs: 100 });
    await harness.handler.install();

    browser.emit('Target.targetCreated', target('destroyed', 'main'));
    browser.emit('Target.targetDestroyed', { targetId: 'destroyed' });
    await waitFor(() => harness.events.some((event) => event.kind === 'recording_degraded'));

    browser.emit('Target.targetCreated', target('disconnected', 'main'));
    browser.detached = true;
    browser.emit('Target.detachedFromTarget', { sessionId: 'pending-session' });
    await waitFor(
      () => harness.events.filter((event) => event.kind === 'recording_degraded').length === 2,
    );
    expect(harness.instrument).not.toHaveBeenCalled();
    await harness.handler.dispose();
  });
});

class FakeSession extends EventEmitter {
  public readonly registry = new Map<string, FakeSession>();
  public readonly commands: [string, unknown][] = [];
  public detached = false;
  public onAttach: ((targetId: string) => Promise<string>) | undefined;

  public constructor(private readonly sessionId: string) {
    super();
  }

  public id(): string {
    return this.sessionId;
  }

  public connection(): { session: (id: string) => CDPSession | null } {
    return { session: (id) => (this.registry.get(id) as unknown as CDPSession) ?? null };
  }

  public async send(method: string, params?: unknown): Promise<unknown> {
    this.commands.push([method, params]);
    if (method === 'Target.attachToTarget') {
      const targetId = (params as { targetId: string }).targetId;
      return { sessionId: await this.onAttach?.(targetId) };
    }
    return {};
  }
}

function recorderHarness(
  browser: FakeSession,
  options: {
    readonly attachmentTimeoutMs?: number;
    readonly instrument?: ReturnType<typeof vi.fn>;
  } = {},
): {
  readonly handler: PopupHandler;
  readonly events: PopupHandlerEvent[];
  readonly instrument: ReturnType<typeof vi.fn>;
  readonly closed: ReturnType<typeof vi.fn>;
} {
  const events: PopupHandlerEvent[] = [];
  const instrument = options.instrument ?? vi.fn().mockResolvedValue(undefined);
  const closed = vi.fn().mockResolvedValue(undefined);
  const callbacks: PopupHandlerCallbacks = {
    onEvent: (event) => events.push(event),
    onPopupSession: instrument,
    onPopupSessionClosed: closed,
    onUnrecordedOrigin: () => undefined,
  };
  return {
    handler: new PopupHandler(browser as unknown as CDPSession, 'main', 'recording', callbacks, {
      attachmentTimeoutMs: options.attachmentTimeoutMs,
    }),
    events,
    instrument,
    closed,
  };
}

function target(targetId: string, openerId: string): unknown {
  return { targetInfo: { targetId, openerId, type: 'page', url: `https://fixture/${targetId}` } };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for popup test condition');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
