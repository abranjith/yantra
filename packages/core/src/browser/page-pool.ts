/**
 * One shared headless browser for a run's background page work (FEAT-050).
 *
 * Every SERP scrape and every fetch fallback in an agentic run borrows a page
 * from this pool instead of launching its own Chrome. The pool:
 *
 * - launches one headless, ephemeral browser lazily, on first use; concurrent
 *   first callers share that one launch;
 * - gives each use a fresh **isolated browser context**, so no cookie, storage,
 *   or cache entry from one background read is visible to the next, and closes
 *   the context when the use ends;
 * - keeps at most `maxConcurrentPages` pages open; later callers wait in FIFO
 *   order, and a waiter whose signal aborts leaves the queue without a slot;
 * - honors each use's timeout and abort signal — on either, the context is
 *   closed, which cancels the page work in flight;
 * - after a crash or disconnect, relaunches at most `maxRelaunches` times per
 *   run, then fails typed ({@link PagePoolExhaustedError}).
 *
 * The run's task browser (`AgentBrowserController`) is deliberately separate:
 * it may run headed for `do`, and its page carries the user-visible interaction
 * state that background contexts must neither see nor disturb. A run therefore
 * starts at most two Chrome processes: this pool's and the task browser's.
 */

import { abortError, raceDeadline, type PageSource, type PageUseOptions } from './page-source.js';
import type { BrowserProvider, BrowserSession, Logger, Page } from './types.js';

/** `withPage` was called on (or was waiting when) the pool closed. */
export class PagePoolClosedError extends Error {
  public override readonly name = 'PagePoolClosedError';

  public constructor() {
    super('The background page pool is closed; no further page work can run in this run.');
  }
}

/** The pool's browser died more often than this run allows it to relaunch. */
export class PagePoolExhaustedError extends Error {
  public override readonly name = 'PagePoolExhaustedError';

  public constructor(public readonly launches: number) {
    super(
      `The background browser stopped after ${launches} launch(es) and will not be relaunched ` +
        'again in this run.',
    );
  }
}

/** Construction options. */
export interface PagePoolOptions {
  /** Launches the pool's browser (the run's counting-decorated provider). */
  readonly provider: BrowserProvider;
  /** Most pages open at once. Default 2. */
  readonly maxConcurrentPages?: number;
  /** Relaunches allowed after a crash or disconnect. Default 1. */
  readonly maxRelaunches?: number;
  /** Receives the one `page pool launched` line per browser process. */
  readonly logger?: Logger;
}

/** Counters for the run-health summary. */
export interface PagePoolStats {
  /** Browser processes the pool launched. */
  readonly launches: number;
  /** Isolated contexts opened (one per use). */
  readonly contexts: number;
  /** Most pages open at once. */
  readonly peakConcurrency: number;
  /** Uses that ran past their deadline. */
  readonly timeouts: number;
}

interface Waiter {
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
}

/** One per run; implements {@link PageSource}. */
export class PagePool implements PageSource {
  private readonly provider: BrowserProvider;
  private readonly maxConcurrentPages: number;
  private readonly maxRelaunches: number;
  private readonly logger: Logger | undefined;

  private session: BrowserSession | null = null;
  private sessionDead = false;
  private launching: Promise<BrowserSession> | null = null;
  private closing: Promise<void> | null = null;
  private readonly waiters: Waiter[] = [];
  private active = 0;
  private launches = 0;
  private contexts = 0;
  private peak = 0;
  private timeouts = 0;

  public constructor(options: PagePoolOptions) {
    this.provider = options.provider;
    this.maxConcurrentPages = Math.max(1, Math.floor(options.maxConcurrentPages ?? 2));
    this.maxRelaunches = Math.max(0, Math.floor(options.maxRelaunches ?? 1));
    this.logger = options.logger;
  }

  /** @inheritdoc */
  public async withPage<T>(fn: (page: Page) => Promise<T>, opts: PageUseOptions): Promise<T> {
    if (this.closing !== null) throw new PagePoolClosedError();
    opts.signal.throwIfAborted();
    await this.acquireSlot(opts.signal);
    try {
      const session = await this.ensureSession();
      const page = await session.newIsolatedPage();
      this.contexts += 1;
      try {
        return await raceDeadline(
          fn(page),
          opts,
          () => page.close(),
          () => {
            this.timeouts += 1;
          },
        );
      } finally {
        // Closing the facade closes its context. A context the deadline path
        // already closed (or a crashed browser) makes this a no-op failure.
        // swallow-ok: the use's own outcome is what the caller needs.
        await page.close().catch(() => undefined);
      }
    } finally {
      this.releaseSlot();
    }
  }

  /**
   * Close the pool's browser and refuse further use. Idempotent; concurrent
   * callers share one close. Waiters still queued are rejected.
   */
  public close(): Promise<void> {
    this.closing ??= this.runClose();
    return this.closing;
  }

  /** Counters for run health. */
  public stats(): PagePoolStats {
    return {
      launches: this.launches,
      contexts: this.contexts,
      peakConcurrency: this.peak,
      timeouts: this.timeouts,
    };
  }

  private async runClose(): Promise<void> {
    for (const waiter of this.waiters.splice(0)) {
      waiter.signal.removeEventListener('abort', waiter.onAbort);
      waiter.reject(new PagePoolClosedError());
    }
    const pending = this.launching;
    // swallow-ok: a launch that failed has nothing to close; its caller got the error.
    const launched = pending === null ? null : await pending.catch(() => null);
    const session = this.session ?? launched;
    this.session = null;
    if (session !== null) await session.close();
  }

  /**
   * The live session, launching (or relaunching) as needed. The launch
   * promise is published synchronously, so concurrent callers — including
   * those arriving while a dead session is being released — share one launch.
   */
  private ensureSession(): Promise<BrowserSession> {
    if (this.session !== null && !this.sessionDead) return Promise.resolve(this.session);
    this.launching ??= this.startSession().finally(() => {
      this.launching = null;
    });
    return this.launching;
  }

  private async startSession(): Promise<BrowserSession> {
    if (this.session !== null) {
      // The previous browser crashed or disconnected. Release what is left.
      const dead = this.session;
      this.session = null;
      // swallow-ok: a crashed session tears itself down; this only reclaims leftovers.
      await dead.close().catch(() => undefined);
    }
    if (this.launches >= 1 + this.maxRelaunches) throw new PagePoolExhaustedError(this.launches);
    return this.launch();
  }

  private async launch(): Promise<BrowserSession> {
    // A launch failure propagates as the provider's typed startup error, so
    // the caller's browser-startup mapping still classifies it.
    const session = await this.provider.launch({ profile: { kind: 'ephemeral' }, headless: true });
    if (this.closing !== null) {
      await session.close();
      throw new PagePoolClosedError();
    }
    this.launches += 1;
    this.session = session;
    this.sessionDead = false;
    const markDead = (): void => {
      if (this.session === session) this.sessionDead = true;
    };
    session.on('crashed', markDead);
    session.on('disconnected', markDead);
    this.logger?.info({ sessionId: session.id }, 'page pool launched');
    return session;
  }

  private acquireSlot(signal: AbortSignal): Promise<void> {
    if (this.active < this.maxConcurrentPages && this.waiters.length === 0) {
      this.take();
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        signal,
        onAbort: () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(abortError(signal));
        },
      };
      signal.addEventListener('abort', waiter.onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private releaseSlot(): void {
    this.active -= 1;
    const next = this.waiters.shift();
    if (next === undefined) return;
    next.signal.removeEventListener('abort', next.onAbort);
    this.take();
    next.resolve();
  }

  private take(): void {
    this.active += 1;
    this.peak = Math.max(this.peak, this.active);
  }
}
