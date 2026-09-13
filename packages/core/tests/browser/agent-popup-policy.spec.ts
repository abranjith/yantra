// @no-llm
import { EventEmitter } from 'node:events';

import type { Page } from 'puppeteer-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentBrowserController } from '../../src/browser/agent-controller.js';

describe('@no-llm page-scoped agent popup policy', () => {
  afterEach(() => vi.useRealTimers());

  it('captures a popup emitted synchronously and keeps opener provenance across redirect', async () => {
    const { controller, internals, opener } = harness('https://shop.example/search');
    const popup = new FakePage('https://shop.example/results');

    opener.emit('popup', popup.asPage());
    opener.currentUrl = 'https://partner.example/redirect';
    await settleTasks(internals);

    expect(internals.popupUrls).toEqual(['https://shop.example/results']);
    expect(internals.pendingPopup?.openerUrl).toBe('https://shop.example/search');
    await controller.teardown();
  });

  it('shares one capture task between the permanent listener and declared waiter', async () => {
    const { controller, internals, opener } = harness('https://app.example/');
    const popup = new FakePage('https://app.example/next');
    const waiter = internals.createDeclaredPopupWaiter(opener.asPage());

    opener.emit('popup', popup.asPage());
    await waiter.promise;
    await settleTasks(internals);

    expect(internals.popupUrls).toEqual(['https://app.example/next']);
    expect(internals.popupCaptureTasks.size).toBe(0);
    await controller.teardown();
  });

  it('bounds a declared-popup wait and removes its exact temporary callback', async () => {
    vi.useFakeTimers();
    const { controller, internals, opener } = harness('https://app.example/');
    const baseline = opener.listenerCount('popup');
    const waiter = internals.createDeclaredPopupWaiter(opener.asPage());

    expect(opener.listenerCount('popup')).toBe(baseline + 1);
    await vi.runAllTimersAsync();
    await waiter.promise;
    expect(opener.listenerCount('popup')).toBe(baseline);
    await controller.teardown();
  });

  it('closes a blank popup that closes or never settles', async () => {
    vi.useFakeTimers();
    const { controller, internals, opener } = harness('https://app.example/');
    const popup = new FakePage('about:blank');
    opener.emit('popup', popup.asPage());
    popup.closed = true;

    await vi.runAllTimersAsync();
    await settleTasks(internals);
    expect(popup.close).toHaveBeenCalledTimes(1);
    expect(internals.pendingPopup).toBeNull();
    await controller.teardown();
  });

  it('removes permanent callbacks and prevents late capture from repopulating state', async () => {
    vi.useFakeTimers();
    const { controller, internals, opener } = harness('https://app.example/');
    const popup = new FakePage('about:blank');
    opener.emit('popup', popup.asPage());
    const teardown = controller.teardown();

    await vi.runAllTimersAsync();
    await teardown;
    expect(opener.listenerCount('popup')).toBe(0);
    expect(opener.listenerCount('dialog')).toBe(0);
    expect(internals.pendingPopup).toBeNull();
    expect(popup.close).toHaveBeenCalled();
  });
});

class FakePage extends EventEmitter {
  currentUrl: string;
  closed = false;
  readonly close = vi.fn(async () => {
    this.closed = true;
  });
  readonly bringToFront = vi.fn(async () => undefined);

  constructor(url: string) {
    super();
    this.currentUrl = url;
  }

  url(): string {
    return this.currentUrl;
  }

  isClosed(): boolean {
    return this.closed;
  }

  asPage(): Page {
    return this as unknown as Page;
  }
}

interface PopupInternals {
  page: Page | null;
  session: { close(): Promise<void> } | null;
  popupUrls: string[];
  pendingPopup: { page: Page; openerUrl: string } | null;
  popupCaptureTasks: Set<Promise<void>>;
  createDeclaredPopupWaiter(page: Page): { promise: Promise<void>; cancel(): void };
  installPagePolicies(page: Page): void;
}

function harness(openerUrl: string): {
  controller: AgentBrowserController;
  internals: PopupInternals;
  opener: FakePage;
} {
  const controller = new AgentBrowserController({
    runId: 'popup-policy-test',
    browserProvider: {} as never,
  });
  const internals = controller as unknown as PopupInternals;
  const opener = new FakePage(openerUrl);
  internals.page = opener.asPage();
  internals.session = { close: vi.fn(async () => undefined) };
  internals.installPagePolicies(opener.asPage());
  return { controller, internals, opener };
}

async function settleTasks(internals: PopupInternals): Promise<void> {
  await Promise.allSettled([...internals.popupCaptureTasks]);
  await Promise.resolve();
}
