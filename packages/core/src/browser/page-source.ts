/**
 * Where background page work gets a browser page (FEAT-050).
 *
 * Two callers need a page for a moment and never show it to anyone: the
 * scraped-search transport (render a results page) and the fetch fallback
 * (render a page the HTTP tier could not read). Before this seam each of them
 * launched its own Chrome per call, so run `20260925T130634Z` started 48
 * processes, and the fetch fallback ignored its timeout and abort signal.
 *
 * {@link PageSource} is the one contract both use: run `fn` on a page, honor
 * `timeoutMs` and `signal`, and clean up whatever was opened. An agentic run
 * passes its shared {@link PagePool}; the deterministic `ask`/`research`
 * paths keep one launch per use through {@link launchPerUsePageSource}.
 */

import type { BrowserProvider, Page } from './types.js';

/** Per-use bounds every {@link PageSource} honors. */
export interface PageUseOptions {
  /** Ceiling on the whole use, from acquiring the page to `fn` settling. */
  readonly timeoutMs: number;
  /** Cancels the use (and any wait for a page) with the signal's reason. */
  readonly signal: AbortSignal;
}

/** A source of short-lived, headless browser pages for background work. */
export interface PageSource {
  /**
   * Run `fn` on a page, then release it.
   *
   * @param fn The page work. The page is valid only until `fn` settles.
   * @param opts Timeout and cancellation for this use.
   * @returns What `fn` returns.
   * @throws {PageTimeoutError} when the use exceeds `timeoutMs` (its page is
   *   closed, which cancels in-flight page work).
   * @throws The signal's abort reason when cancelled (wrapped in a
   *   {@link PageAbortedError} when the reason is not an `Error`).
   */
  withPage<T>(fn: (page: Page) => Promise<T>, opts: PageUseOptions): Promise<T>;
}

/**
 * A page use was cancelled by a signal whose reason is not an `Error` (for
 * example the agent middleware's `'timeout'` string). An `Error` reason is
 * rethrown as it is; this wraps anything else so callers always get an Error.
 */
export class PageAbortedError extends Error {
  public override readonly name = 'PageAbortedError';

  public constructor(public readonly reason: unknown) {
    super('Browser page work was cancelled.');
  }
}

/** The error a cancelled page use rejects with: the signal's reason, as an Error. */
export function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new PageAbortedError(reason);
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/** A page use ran past its deadline; its page was closed. */
export class PageTimeoutError extends Error {
  public override readonly name = 'PageTimeoutError';

  public constructor(public readonly timeoutMs: number) {
    super(`Browser page work timed out after ${timeoutMs}ms.`);
  }
}

/**
 * Today's per-use behavior, kept for the deterministic `ask`/`research`
 * paths: launch a headless ephemeral browser, open one page, run `fn` under
 * the same deadline a pool honors, and close the browser in `finally`.
 *
 * @param provider The browser provider to launch from.
 */
export function launchPerUsePageSource(provider: BrowserProvider): PageSource {
  return {
    async withPage<T>(fn: (page: Page) => Promise<T>, opts: PageUseOptions): Promise<T> {
      opts.signal.throwIfAborted();
      const session = await provider.launch({ profile: { kind: 'ephemeral' }, headless: true });
      try {
        const page = await session.newPage();
        return await raceDeadline(fn(page), opts, () => page.close());
      } finally {
        await session.close();
      }
    },
  };
}

/**
 * Settle with `work`, or reject at the deadline or on abort — whichever comes
 * first. On a deadline or abort, `cancel` runs (closing the page cancels the
 * work still running on it) and the late outcome of `work` is ignored.
 *
 * @internal Shared by every {@link PageSource} so they cannot disagree.
 */
export function raceDeadline<T>(
  work: Promise<T>,
  opts: PageUseOptions,
  cancel: () => Promise<unknown>,
  onTimeout: () => void = () => undefined,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (): boolean => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      opts.signal.removeEventListener('abort', onAbort);
      return true;
    };
    const abandon = (reason: Error): void => {
      if (!finish()) return;
      // swallow-ok: closing a page whose work was abandoned is best-effort; the
      // caller already has the deadline or abort error, which is the outcome.
      void cancel().catch(() => undefined);
      reject(reason);
    };
    const onAbort = (): void => abandon(abortError(opts.signal));
    const timer = setTimeout(() => {
      onTimeout();
      abandon(new PageTimeoutError(opts.timeoutMs));
    }, opts.timeoutMs);
    timer.unref?.();
    if (opts.signal.aborted) {
      onAbort();
      return;
    }
    opts.signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        if (finish()) resolve(value);
      },
      (error: unknown) => {
        if (finish()) reject(asError(error));
      },
    );
  });
}
