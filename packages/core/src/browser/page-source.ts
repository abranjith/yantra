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
      return withPageDeadline(async (signal, assertActive) => {
        const session = await provider.launch({ profile: { kind: 'ephemeral' }, headless: true });
        try {
          assertActive();
          const page = await session.newPage();
          return await useAcquiredPage(page, signal, fn, assertActive);
        } finally {
          await session.close();
        }
      }, opts);
    },
  };
}

/** @internal One deadline covers queueing, acquisition, work, and cleanup. */
export function withPageDeadline<T>(
  work: (signal: AbortSignal, assertActive: () => void) => Promise<T>,
  opts: PageUseOptions,
  onTimeout: () => void = () => undefined,
): Promise<T> {
  if (opts.signal.aborted) return Promise.reject(abortError(opts.signal));
  const cancellation = new AbortController();
  const deadline = performance.now() + opts.timeoutMs;
  let timedOut = false;
  const recordTimeout = (): void => {
    if (timedOut) return;
    timedOut = true;
    onTimeout();
  };
  const assertActive = (): void => {
    cancellation.signal.throwIfAborted();
    if (performance.now() >= deadline) {
      const error = new PageTimeoutError(opts.timeoutMs);
      cancellation.abort(error);
      recordTimeout();
      throw error;
    }
  };
  const pending = Promise.resolve().then(async () => {
    assertActive();
    const value = await work(cancellation.signal, assertActive);
    assertActive();
    return value;
  });
  return raceDeadline(
    pending,
    opts,
    () => {
      cancellation.abort(
        opts.signal.aborted ? abortError(opts.signal) : new PageTimeoutError(opts.timeoutMs),
      );
      return Promise.resolve();
    },
    recordTimeout,
  );
}

/** @internal A late-acquired page is closed without running a cancelled callback. */
export async function useAcquiredPage<T>(
  page: Page,
  signal: AbortSignal,
  fn: (page: Page) => Promise<T>,
  assertActive: () => void,
): Promise<T> {
  let cancel: () => void = () => undefined;
  try {
    assertActive();
    return await new Promise<T>((resolve, reject) => {
      cancel = () => {
        // swallow-ok: deadline cancellation may already have closed the context.
        void page.close().catch(() => undefined);
        reject(abortError(signal));
      };
      signal.addEventListener('abort', cancel, { once: true });
      void Promise.resolve()
        .then(() => {
          assertActive();
          return fn(page);
        })
        .then(resolve, reject);
    });
  } finally {
    signal.removeEventListener('abort', cancel);
    // swallow-ok: preserve the page-work outcome after a crash or cancellation.
    await page.close().catch(() => undefined);
  }
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
    work.then(
      (value) => {
        if (finish()) resolve(value);
      },
      (error: unknown) => {
        if (finish()) reject(asError(error));
      },
    );
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });
  });
}
