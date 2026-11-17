// @no-llm
import { EventEmitter } from 'node:events';

import type { Page as PuppeteerPage } from 'puppeteer-core';
import { describe, expect, it, vi } from 'vitest';

import { PageSettler } from '../../src/browser/page-settle.js';

/** Just enough of a Puppeteer page for the settler's listeners. */
function fakePage(): { page: PuppeteerPage; commit(): void; subframe(): void } {
  const emitter = new EventEmitter();
  const mainFrame = { name: 'main' };
  const page = Object.assign(emitter, { mainFrame: () => mainFrame }) as unknown as PuppeteerPage;
  return {
    page,
    commit: () => emitter.emit('framenavigated', mainFrame),
    subframe: () => emitter.emit('framenavigated', { name: 'child' }),
  };
}

describe('@no-llm PageSettler.addNavigationListener (FEAT-069)', () => {
  it('runs after the epoch bump and after the owner hook', () => {
    const { page, commit } = fakePage();
    const order: string[] = [];
    const settler = new PageSettler(page, { onNavigationCommitted: () => order.push('owner') });
    settler.addNavigationListener(() => order.push(`live-view@${settler.epoch}`));
    commit();
    expect(order).toEqual(['owner', 'live-view@1']);
  });

  it('ignores subframe navigations, like the epoch does', () => {
    const { page, subframe } = fakePage();
    const settler = new PageSettler(page);
    const listener = vi.fn();
    settler.addNavigationListener(listener);
    subframe();
    expect(listener).not.toHaveBeenCalled();
    expect(settler.epoch).toBe(0);
  });

  it('routes a listener error to onListenerError without touching the bookkeeping', () => {
    const { page, commit } = fakePage();
    const onListenerError = vi.fn();
    const settler = new PageSettler(page, { onListenerError });
    const after = vi.fn();
    settler.addNavigationListener(() => {
      throw new Error('listener bug');
    });
    settler.addNavigationListener(after);
    expect(() => commit()).not.toThrow();
    expect(settler.epoch).toBe(1);
    expect(after).toHaveBeenCalledOnce();
    expect(onListenerError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'listener bug' }),
    );
  });

  it('stops calling a removed listener, and dispose removes them all', () => {
    const { page, commit } = fakePage();
    const settler = new PageSettler(page);
    const removed = vi.fn();
    const kept = vi.fn();
    const remove = settler.addNavigationListener(removed);
    settler.addNavigationListener(kept);
    remove();
    commit();
    expect(removed).not.toHaveBeenCalled();
    expect(kept).toHaveBeenCalledOnce();
    settler.dispose();
    commit();
    expect(kept).toHaveBeenCalledOnce();
  });
});
