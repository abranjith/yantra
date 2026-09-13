import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ElementHandle, Frame, Page } from 'puppeteer-core';

import type { InjectedScriptHost } from './types.js';

const moduleDir = dirname(fileURLToPath(import.meta.url));
let bundlePromise: Promise<string> | undefined;
let nextHostId = 1;

/**
 * Production bridge between the Node locator engine and its browser-side IIFE.
 * The bundle is installed for every new document and injected immediately into
 * the main frame plus any currently attached same-origin child frames.
 */
export class PuppeteerInjectedScriptHost implements InjectedScriptHost {
  private preloadInstalled = false;
  private readonly hostId = nextHostId++;
  private nextFrameToken = 1;
  private readonly frameTokens = new WeakMap<Frame, string>();

  public constructor(
    private readonly page: Page,
    private readonly sourceOverride?: string,
  ) {}

  /** @inheritdoc */
  public async ensureInjected(frameId: string): Promise<void> {
    const source = this.sourceOverride ?? (await loadInjectedBundle());
    if (!this.preloadInstalled) {
      await this.page.evaluateOnNewDocument(source);
      this.preloadInstalled = true;
    }

    const requested = this.resolveFrame(frameId);
    const frames =
      frameId === 'main'
        ? [requested, ...this.page.frames().filter((f) => f !== requested)]
        : [requested];
    for (const frame of frames) {
      try {
        const installed = await frame.evaluate(() =>
          Boolean((globalThis as { __yantra?: unknown }).__yantra),
        );
        if (!installed) await frame.evaluate(source);
      } catch (err) {
        // Detached/cross-origin frames are best effort. For the requested
        // frame, surface the underlying Puppeteer cause (often a mid-navigation
        // "Execution context was destroyed") instead of masking it — the
        // auto-wait layer classifies that message as transient and keeps
        // polling until the new document settles. Swallowing it here would turn
        // a recoverable navigation race into a fatal, unclassifiable failure.
        if (frame === requested) {
          const detail = err instanceof Error ? err.message : String(err);
          throw new Error(`Unable to inject locator runtime into frame "${frameId}": ${detail}`, {
            cause: err,
          });
        }
      }
    }
  }

  /** @inheritdoc */
  public async call<T>(frameId: string, fn: string, args: readonly unknown[]): Promise<T> {
    await this.ensureInjected(frameId);
    const frame = this.resolveFrame(frameId);
    return frame.evaluate(
      (functionName, functionArgs) => {
        const api = (globalThis as { __yantra?: Record<string, (...values: unknown[]) => unknown> })
          .__yantra;
        const callable = api?.[functionName];
        if (typeof callable !== 'function')
          throw new Error(`Unknown injected locator function: ${functionName}`);
        return callable(...functionArgs);
      },
      fn,
      [...args],
    ) as Promise<T>;
  }

  /** @inheritdoc */
  public async callHandle(frameId: string, expression: string): Promise<ElementHandle | null> {
    await this.ensureInjected(frameId);
    const handle = await this.resolveFrame(frameId).evaluateHandle(expression);
    const element = handle.asElement() as ElementHandle | null;
    if (element === null) await handle.dispose();
    return element;
  }

  /**
   * Return an opaque token scoped to this host and the currently attached
   * Frame object. Tokens are never persisted and are not inferred from URL,
   * name, or private Puppeteer fields.
   */
  public getFrameId(frame: Frame): string {
    const attached = this.page.frames();
    if (!attached.includes(frame)) throw new Error('Cannot tokenize a foreign or detached frame.');
    if (frame === this.page.mainFrame()) return 'main';
    let token = this.frameTokens.get(frame);
    if (!token) {
      token = `frame:${this.hostId}:${this.nextFrameToken++}`;
      this.frameTokens.set(frame, token);
    }
    return token;
  }

  private resolveFrame(frameId: string): Frame {
    if (frameId === 'main') return this.page.mainFrame();
    const frame = this.page
      .frames()
      .find((candidate) => this.frameTokens.get(candidate) === frameId);
    if (!frame) throw new Error(`Frame "${frameId}" is detached or unknown.`);
    return frame;
  }
}

/** Load the generated browser IIFE from either source-test or built layout. */
async function loadInjectedBundle(): Promise<string> {
  bundlePromise ??= readFirst([
    resolve(moduleDir, '..', 'injected.bundle.js'),
    resolve(moduleDir, '..', '..', 'dist', 'injected.bundle.js'),
  ]);
  return bundlePromise;
}

async function readFirst(paths: readonly string[]): Promise<string> {
  let lastError: unknown;
  for (const path of paths) {
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    'Locator injected bundle is missing. Run `pnpm --filter @yantra/core build:injected` before launching Chrome.',
    { cause: lastError },
  );
}
