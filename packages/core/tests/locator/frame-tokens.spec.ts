// @no-llm
import type { Frame, Page } from 'puppeteer-core';
import { describe, expect, it, vi } from 'vitest';

import { PuppeteerInjectedScriptHost } from '../../src/locator/injected-host.js';

describe('@no-llm public session-local locator frame tokens', () => {
  it('uses main sentinel and stable, distinct opaque tokens for attached siblings', () => {
    const main = fakeFrame();
    const first = fakeFrame();
    const second = fakeFrame();
    const page = fakePage(main, [main, first, second]);
    const host = new PuppeteerInjectedScriptHost(page, 'SOURCE');

    expect(host.getFrameId(main)).toBe('main');
    expect(host.getFrameId(first)).toBe(host.getFrameId(first));
    expect(host.getFrameId(first)).not.toBe(host.getFrameId(second));
  });

  it('rejects cross-host, foreign, detached, and replaced frames', async () => {
    const main = fakeFrame();
    const child = fakeFrame();
    const frames = [main, child];
    const page = fakePage(main, frames);
    const host = new PuppeteerInjectedScriptHost(page, 'SOURCE');
    const otherHost = new PuppeteerInjectedScriptHost(page, 'SOURCE');
    const token = host.getFrameId(child);

    await expect(otherHost.call(token, 'noop', [])).rejects.toThrow(/detached or unknown/);
    expect(() => host.getFrameId(fakeFrame())).toThrow(/foreign or detached/);
    frames.splice(frames.indexOf(child), 1);
    await expect(host.call(token, 'noop', [])).rejects.toThrow(/detached or unknown/);

    const replacement = fakeFrame();
    frames.push(replacement);
    expect(host.getFrameId(replacement)).not.toBe(token);
  });

  it('surfaces requested-frame injection and navigation failures with the token', async () => {
    const main = fakeFrame();
    const failure = new Error('Execution context was destroyed during navigation');
    const child = fakeFrame(failure);
    const page = fakePage(main, [main, child]);
    const host = new PuppeteerInjectedScriptHost(page, 'SOURCE');
    const token = host.getFrameId(child);

    await expect(host.ensureInjected(token)).rejects.toThrow(
      new RegExp(`${token}.*Execution context was destroyed`),
    );
  });
});

function fakeFrame(error?: Error): Frame {
  return {
    evaluate: error ? vi.fn().mockRejectedValue(error) : vi.fn().mockResolvedValue(true),
    evaluateHandle: vi.fn(),
  } as unknown as Frame;
}

function fakePage(main: Frame, frames: Frame[]): Page {
  return {
    evaluateOnNewDocument: vi.fn().mockResolvedValue(undefined),
    mainFrame: () => main,
    frames: () => frames,
  } as unknown as Page;
}
