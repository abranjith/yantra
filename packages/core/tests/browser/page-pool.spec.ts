import { createServer, type Server } from 'node:http';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { BrowserLaunchError } from '../../src/browser/errors.js';
import {
  PagePool,
  PagePoolClosedError,
  PagePoolExhaustedError,
} from '../../src/browser/page-pool.js';
import {
  PageAbortedError,
  PageTimeoutError,
  launchPerUsePageSource,
} from '../../src/browser/page-source.js';
import { LocalProfileStore } from '../../src/browser/profile-store.js';
import { LocalBrowserProvider } from '../../src/browser/provider.js';
import type {
  BrowserProvider,
  BrowserSession,
  BrowserSessionEvent,
  Logger,
  Page,
} from '../../src/browser/types.js';
import {
  beginMigrationBrowserFixture,
  type MigrationBrowserFixture,
} from '../helpers/migration-browser.js';

const silent: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

interface FakeSessionHandle extends BrowserSession {
  emitEvent(event: BrowserSessionEvent): void;
  closed(): boolean;
}

/** A provider counting launches, isolated contexts, and context closes. */
function fakeProvider(options: { readonly launchDelayMs?: number } = {}) {
  const sessions: FakeSessionHandle[] = [];
  let contexts = 0;
  let contextCloses = 0;
  const provider: BrowserProvider = {
    launch: async () => {
      if (options.launchDelayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, options.launchDelayMs));
      }
      const handlers = new Map<BrowserSessionEvent, ((...args: unknown[]) => void)[]>();
      let isClosed = false;
      const session: FakeSessionHandle = {
        id: `session-${sessions.length + 1}`,
        chrome: {
          path: '/fake/chrome',
          version: '130.0.0.0',
          majorVersion: 130,
          channel: 'stable',
          source: 'system',
        },
        profilePath: '/tmp/fake',
        newPage: () => Promise.reject(new Error('the pool must only use isolated pages')),
        newIsolatedPage: () => {
          contexts += 1;
          return Promise.resolve(fakePage(() => (contextCloses += 1)));
        },
        close: () => {
          isClosed = true;
          return Promise.resolve();
        },
        on: (event, handler) => {
          handlers.set(event, [...(handlers.get(event) ?? []), handler]);
        },
        emitEvent: (event) => {
          for (const handler of handlers.get(event) ?? []) handler();
        },
        closed: () => isClosed,
      };
      sessions.push(session);
      return session;
    },
    detectChrome: () => Promise.resolve(null),
  };
  return {
    provider,
    sessions,
    launches: () => sessions.length,
    contexts: () => contexts,
    contextCloses: () => contextCloses,
  };
}

function fakePage(onClose: () => void): Page {
  return {
    goto: () => Promise.resolve(null),
    evaluate: <T>() => Promise.resolve(undefined as T),
    close: () => {
      onClose();
      return Promise.resolve();
    },
    url: () => 'about:blank',
    on: () => undefined,
  };
}

const OPTS = { timeoutMs: 5_000, signal: new AbortController().signal } as const;

/** A promise plus the function that resolves it. */
function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('@no-llm browser/page-pool', () => {
  it('serves five concurrent uses from one launch, five contexts, and at most two open pages', async () => {
    const fake = fakeProvider();
    const pool = new PagePool({ provider: fake.provider });
    const gate = deferred();

    const uses = Array.from({ length: 5 }, () => pool.withPage(() => gate.promise, OPTS));
    await new Promise((resolve) => setTimeout(resolve, 5));
    gate.resolve();
    await Promise.all(uses);

    expect(fake.launches()).toBe(1);
    expect(fake.contexts()).toBe(5);
    expect(fake.contextCloses()).toBe(5);
    expect(pool.stats()).toEqual({ launches: 1, contexts: 5, peakConcurrency: 2, timeouts: 0 });
  });

  it('shares one launch between concurrent first callers', async () => {
    const fake = fakeProvider({ launchDelayMs: 20 });
    const pool = new PagePool({ provider: fake.provider, maxConcurrentPages: 4 });

    await Promise.all([1, 2, 3].map(() => pool.withPage(() => Promise.resolve(), OPTS)));

    expect(fake.launches()).toBe(1);
  });

  it('serves waiters in FIFO order', async () => {
    const fake = fakeProvider();
    const pool = new PagePool({ provider: fake.provider, maxConcurrentPages: 1 });
    const order: number[] = [];
    const first = deferred();

    const uses = [
      pool.withPage(async () => {
        order.push(0);
        await first.promise;
      }, OPTS),
      ...[1, 2, 3].map((n) =>
        pool.withPage(() => {
          order.push(n);
          return Promise.resolve();
        }, OPTS),
      ),
    ];
    await new Promise((resolve) => setTimeout(resolve, 5));
    first.resolve();
    await Promise.all(uses);

    expect(order).toEqual([0, 1, 2, 3]);
  });

  it('lets an aborted waiter leave the queue without taking a slot', async () => {
    const fake = fakeProvider();
    const pool = new PagePool({ provider: fake.provider, maxConcurrentPages: 1 });
    const holder = deferred();
    const holding = pool.withPage(() => holder.promise, OPTS);
    const controller = new AbortController();
    const ran = vi.fn(() => Promise.resolve());

    const waiting = pool.withPage(ran, { timeoutMs: 5_000, signal: controller.signal });
    const after = pool.withPage(() => Promise.resolve('next'), OPTS);
    const reason = new Error('gave up');
    controller.abort(reason);

    await expect(waiting).rejects.toBe(reason);
    holder.resolve();
    await holding;
    await expect(after).resolves.toBe('next');
    expect(ran).not.toHaveBeenCalled();
    expect(fake.contexts()).toBe(2);
  });

  it('wraps a non-Error abort reason so callers always receive an Error', async () => {
    const fake = fakeProvider();
    const pool = new PagePool({ provider: fake.provider, maxConcurrentPages: 1 });
    const holder = deferred();
    const holding = pool.withPage(() => holder.promise, OPTS);
    const controller = new AbortController();

    const waiting = pool.withPage(() => Promise.resolve(), {
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    controller.abort('timeout');

    const error = await waiting.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PageAbortedError);
    expect((error as PageAbortedError).reason).toBe('timeout');
    holder.resolve();
    await holding;
  });

  it('rejects an already-aborted use without launching', async () => {
    const fake = fakeProvider();
    const pool = new PagePool({ provider: fake.provider });
    const controller = new AbortController();
    controller.abort(new Error('stop'));

    await expect(
      pool.withPage(() => Promise.resolve(), { timeoutMs: 1_000, signal: controller.signal }),
    ).rejects.toThrow('stop');
    expect(fake.launches()).toBe(0);
  });

  it('times out a hung use at timeoutMs, closes its context, and frees the slot', async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeProvider();
      const pool = new PagePool({ provider: fake.provider, maxConcurrentPages: 1 });

      const hung = pool.withPage(() => new Promise<never>(() => undefined), {
        timeoutMs: 1_000,
        signal: new AbortController().signal,
      });
      const settled = hung.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(999);
      expect(fake.contextCloses()).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(await settled).toBeInstanceOf(PageTimeoutError);

      expect(fake.contextCloses()).toBeGreaterThanOrEqual(1);
      expect(pool.stats().timeouts).toBe(1);
      await expect(pool.withPage(() => Promise.resolve('free'), OPTS)).resolves.toBe('free');
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases the slot and the context when the page work throws', async () => {
    const fake = fakeProvider();
    const pool = new PagePool({ provider: fake.provider, maxConcurrentPages: 1 });

    await expect(pool.withPage(() => Promise.reject(new Error('boom')), OPTS)).rejects.toThrow(
      'boom',
    );

    expect(fake.contextCloses()).toBe(1);
    await expect(pool.withPage(() => Promise.resolve(1), OPTS)).resolves.toBe(1);
  });

  it('relaunches once after a crash, then fails typed on a second crash', async () => {
    const fake = fakeProvider();
    const pool = new PagePool({ provider: fake.provider });

    await pool.withPage(() => Promise.resolve(), OPTS);
    fake.sessions[0]?.emitEvent('crashed');
    await pool.withPage(() => Promise.resolve(), OPTS);
    fake.sessions[1]?.emitEvent('disconnected');

    await expect(pool.withPage(() => Promise.resolve(), OPTS)).rejects.toBeInstanceOf(
      PagePoolExhaustedError,
    );
    expect(fake.launches()).toBe(2);
    expect(fake.sessions[0]?.closed()).toBe(true);
  });

  it('relaunches exactly once for concurrent callers after a crash', async () => {
    const fake = fakeProvider({ launchDelayMs: 10 });
    const pool = new PagePool({ provider: fake.provider, maxConcurrentPages: 3 });
    await pool.withPage(() => Promise.resolve(), OPTS);
    fake.sessions[0]?.emitEvent('crashed');

    await Promise.all([1, 2, 3].map(() => pool.withPage(() => Promise.resolve(), OPTS)));

    expect(fake.launches()).toBe(2);
  });

  it('honors maxRelaunches 0', async () => {
    const fake = fakeProvider();
    const pool = new PagePool({ provider: fake.provider, maxRelaunches: 0 });
    await pool.withPage(() => Promise.resolve(), OPTS);
    fake.sessions[0]?.emitEvent('crashed');

    await expect(pool.withPage(() => Promise.resolve(), OPTS)).rejects.toBeInstanceOf(
      PagePoolExhaustedError,
    );
  });

  it('propagates a typed launch failure', async () => {
    const failure = new BrowserLaunchError({ phase: 'spawn', lastStderr: 'no display', args: [] });
    const pool = new PagePool({
      provider: {
        launch: () => Promise.reject(failure),
        detectChrome: () => Promise.resolve(null),
      },
    });

    await expect(pool.withPage(() => Promise.resolve(), OPTS)).rejects.toBe(failure);
    expect(pool.stats().launches).toBe(0);
  });

  it('logs "page pool launched" once per process, with the session id only', async () => {
    const info = vi.fn();
    const fake = fakeProvider();
    const pool = new PagePool({ provider: fake.provider, logger: { ...silent, info } });

    await pool.withPage(() => Promise.resolve(), OPTS);
    await pool.withPage(() => Promise.resolve(), OPTS);

    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith({ sessionId: 'session-1' }, 'page pool launched');
  });

  it('rejects use after close, closes its browser, and tolerates a second close', async () => {
    const fake = fakeProvider();
    const pool = new PagePool({ provider: fake.provider });
    await pool.withPage(() => Promise.resolve(), OPTS);

    await pool.close();
    await pool.close();

    expect(fake.sessions[0]?.closed()).toBe(true);
    await expect(pool.withPage(() => Promise.resolve(), OPTS)).rejects.toBeInstanceOf(
      PagePoolClosedError,
    );
  });

  it('rejects queued waiters when it closes', async () => {
    const fake = fakeProvider();
    const pool = new PagePool({ provider: fake.provider, maxConcurrentPages: 1 });
    const holder = deferred();
    const holding = pool.withPage(() => holder.promise, OPTS);
    await new Promise((resolve) => setTimeout(resolve, 5));

    const queued = pool.withPage(() => Promise.resolve(), OPTS);
    const closing = pool.close();

    await expect(queued).rejects.toBeInstanceOf(PagePoolClosedError);
    holder.resolve();
    await holding;
    await closing;
  });

  it('closing a never-used pool launches nothing', async () => {
    const fake = fakeProvider();
    const pool = new PagePool({ provider: fake.provider });

    await pool.close();

    expect(fake.launches()).toBe(0);
  });
});

describe('@no-llm browser/page-source launchPerUsePageSource', () => {
  it('launches and closes one browser per use', async () => {
    const fake = fakeProvider();
    const pages = launchPerUsePageSource({
      ...fake.provider,
      launch: async (options) => {
        const session = await fake.provider.launch(options);
        return { ...session, newPage: () => session.newIsolatedPage() };
      },
    });

    await pages.withPage(() => Promise.resolve(), OPTS);
    await pages.withPage(() => Promise.resolve(), OPTS);

    expect(fake.launches()).toBe(2);
    expect(fake.sessions.every((session) => session.closed())).toBe(true);
  });
});

describe('@no-llm browser/page-pool against real Chrome', () => {
  let fixture: MigrationBrowserFixture;
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    fixture = await beginMigrationBrowserFixture();
    server = createServer((request, response) => {
      if (request.url === '/set') {
        response.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'pool=1; Path=/' });
        response.end('<html><body>set</body></html>');
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<html><body>read</body></html>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    baseUrl = `http://127.0.0.1:${address.port}`;
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fixture?.cleanup();
  });

  it('runs two sequential uses in one process, each in its own isolated context', async () => {
    const real = new LocalBrowserProvider({
      profileStore: new LocalProfileStore(),
      logger: silent,
    });
    let launches = 0;
    const pool = new PagePool({
      provider: {
        launch: (options) => {
          launches += 1;
          return real.launch({ ...options, ...fixture.launchOptions });
        },
        detectChrome: () => real.detectChrome(),
      },
    });
    const opts = { timeoutMs: 30_000, signal: new AbortController().signal };

    try {
      const first = await pool.withPage(async (page) => {
        await page.goto(`${baseUrl}/set`);
        return page.evaluate(() => document.cookie);
      }, opts);
      const second = await pool.withPage(async (page) => {
        await page.goto(`${baseUrl}/read`);
        return page.evaluate(() => document.cookie);
      }, opts);

      expect(first).toBe('pool=1');
      expect(second).toBe('');
      expect(launches).toBe(1);
      expect(pool.stats()).toMatchObject({ launches: 1, contexts: 2 });
    } finally {
      await pool.close();
    }
  }, 90_000);
});
