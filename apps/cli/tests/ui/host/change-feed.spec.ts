// @no-llm
/**
 * Change detection (FEAT-065 TASK-008): lease scan, index change token and
 * watcher hints, debounced into `runs.changed` / `prefs.changed`.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { SqliteHistoryStore, openIndexDb } from '@yantra/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ChangeFeed,
  fileStamp,
  registerChangeFeed,
  scanRunsDirectory,
  type ChangeNotification,
  type ChangeSources,
  type FeedTimers,
  type RunSnapshot,
  type WatchFn,
} from '../../../src/ui/host/change-feed.js';
import type { HostLogger } from '../../../src/ui/host/host.js';
import { RpcMethodRegistry } from '../../../src/ui/host/rpc-server.js';

/** A hand-stepped clock implementing {@link FeedTimers}. */
class SteppedTimers implements FeedTimers {
  public now = 0;
  private next = 1;
  private readonly timers = new Map<
    number,
    { at: number; callback: () => void; every: number | null }
  >();

  public setTimeout(callback: () => void, ms: number): unknown {
    const id = this.next++;
    this.timers.set(id, { at: this.now + ms, callback, every: null });
    return id;
  }
  public clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }
  public setInterval(callback: () => void, ms: number): unknown {
    const id = this.next++;
    this.timers.set(id, { at: this.now + ms, callback, every: ms });
    return id;
  }
  public clearInterval(handle: unknown): void {
    this.timers.delete(handle as number);
  }
  public get pending(): number {
    return this.timers.size;
  }

  /** Advances the clock, firing due timers in order and letting their async work settle. */
  public async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      const [id, timer] = due;
      this.now = timer.at;
      if (timer.every === null) this.timers.delete(id);
      else timer.at += timer.every;
      timer.callback();
      await settle();
    }
    this.now = target;
    await settle();
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** In-memory sources the test mutates. */
class FakeSources implements ChangeSources {
  public runs = new Map<string, string | null>();
  public token: number | null = 1;
  public profile: string | null = 'p1';
  public scans = 0;
  public closed = false;
  public scanRuns(): Promise<RunSnapshot> {
    this.scans += 1;
    return Promise.resolve(new Map(this.runs));
  }
  public changeToken(): number | null {
    return this.token;
  }
  public profileStamp(): Promise<string | null> {
    return Promise.resolve(this.profile);
  }
  public close(): void {
    this.closed = true;
  }
}

/** A watcher factory the test can fire or fail. */
class FakeWatch {
  public readonly listeners = new Map<string, (filename: string | null) => void>();
  public readonly errorHandlers: ((error: Error) => void)[] = [];
  public throwOnStart = false;
  public closed = 0;
  public readonly fn: WatchFn = (path, listener) => {
    if (this.throwOnStart) throw Object.assign(new Error('nope'), { code: 'ENOSYS' });
    this.listeners.set(path, listener);
    return {
      close: () => {
        this.closed += 1;
      },
      on: (_event, handler) => {
        this.errorHandlers.push(handler);
      },
    };
  };
}

const RUNS = join('/data', 'runs');
const PROFILE = join('/home', 'profile.yaml');

let timers: SteppedTimers;
let sources: FakeSources;
let watcher: FakeWatch;
let warnings: string[];
let feed: ChangeFeed;
let seen: ChangeNotification[];

function makeFeed(): ChangeFeed {
  const logger: HostLogger = {
    info: () => undefined,
    warn: (_fields, message) => warnings.push(message),
    error: () => undefined,
  };
  return new ChangeFeed({
    openSources: () => Promise.resolve(sources),
    runsRoot: RUNS,
    profilePath: PROFILE,
    watch: watcher.fn,
    timers,
    logger,
  });
}

beforeEach(() => {
  timers = new SteppedTimers();
  sources = new FakeSources();
  watcher = new FakeWatch();
  warnings = [];
  seen = [];
  feed = makeFeed();
});

afterEach(() => {
  feed.close();
});

describe('polling', () => {
  it('reports another connection’s index commit within one poll', async () => {
    await feed.subscribe((n) => seen.push(n));
    sources.token = 2;

    await timers.advance(2_000 + 250);

    expect(seen).toEqual([{ method: 'runs.changed', params: { run_ids: [], live_run_ids: [] } }]);
  });

  it('adds a new lease to live_run_ids and drops it when the lease is removed', async () => {
    // Arrange
    sources.runs.set('r1', null);
    await feed.subscribe((n) => seen.push(n));

    // Act: the lease appears…
    sources.runs.set('r1', 'lease-1');
    await timers.advance(2_250);
    // …then goes away.
    sources.runs.set('r1', null);
    await timers.advance(2_250);

    // Assert
    expect(seen).toEqual([
      { method: 'runs.changed', params: { run_ids: ['r1'], live_run_ids: ['r1'] } },
      { method: 'runs.changed', params: { run_ids: ['r1'], live_run_ids: [] } },
    ]);
  });

  it('reports a new run directory and a removed one', async () => {
    sources.runs.set('old', null);
    await feed.subscribe((n) => seen.push(n));
    sources.runs.delete('old');
    sources.runs.set('new', null);
    await timers.advance(2_250);
    expect(seen).toEqual([
      { method: 'runs.changed', params: { run_ids: ['new', 'old'], live_run_ids: [] } },
    ]);
  });

  it('reports a profile.yaml edit as prefs.changed', async () => {
    await feed.subscribe((n) => seen.push(n));
    sources.profile = 'p2';
    await timers.advance(2_250);
    expect(seen).toEqual([{ method: 'prefs.changed', params: {} }]);
  });

  it('sends nothing when nothing changed', async () => {
    await feed.subscribe((n) => seen.push(n));
    await timers.advance(10_000);
    expect(seen).toEqual([]);
  });
});

describe('debounce', () => {
  it('turns five rapid changes into one notification', async () => {
    // Arrange
    await feed.subscribe((n) => seen.push(n));

    // Act: five hints, each with a fresh change, 40 ms apart.
    for (let i = 0; i < 5; i++) {
      sources.runs.set(`r${i}`, null);
      watcher.listeners.get(RUNS)?.(`r${i}`);
      await timers.advance(40);
    }
    await timers.advance(250);

    // Assert
    expect(seen).toEqual([
      {
        method: 'runs.changed',
        params: { run_ids: ['r0', 'r1', 'r2', 'r3', 'r4'], live_run_ids: [] },
      },
    ]);
  });
});

describe('watcher hints', () => {
  it('scan immediately instead of waiting for the poll', async () => {
    await feed.subscribe((n) => seen.push(n));
    sources.runs.set('fresh', 'lease');

    watcher.listeners.get(RUNS)?.('fresh');
    await timers.advance(0); // the hinted scan settles and arms the debounce
    await timers.advance(250);

    expect(seen).toEqual([
      { method: 'runs.changed', params: { run_ids: ['fresh'], live_run_ids: ['fresh'] } },
    ]);
  });

  it('only react to profile.yaml in its directory', async () => {
    await feed.subscribe((n) => seen.push(n));
    const scans = sources.scans;
    watcher.listeners.get(dirname(PROFILE))?.('config.yaml');
    await timers.advance(0);
    expect(sources.scans).toBe(scans);
    watcher.listeners.get(dirname(PROFILE))?.('profile.yaml');
    await timers.advance(0);
    expect(sources.scans).toBe(scans + 1);
  });

  it('fall back to polling on a watcher error, logged once', async () => {
    // Arrange
    await feed.subscribe((n) => seen.push(n));

    // Act: both watchers fail (EMFILE), then a change happens.
    for (const handler of watcher.errorHandlers)
      handler(Object.assign(new Error('x'), { code: 'EMFILE' }));
    sources.token = 9;
    await timers.advance(2_250);

    // Assert
    expect(warnings).toEqual(['file watching unavailable; change detection is polling only']);
    expect(watcher.closed).toBe(2);
    expect(seen).toHaveLength(1);
  });

  it('fall back to polling when a watcher cannot start', async () => {
    watcher.throwOnStart = true;
    await feed.subscribe((n) => seen.push(n));
    sources.profile = 'p2';
    await timers.advance(2_250);
    expect(warnings).toHaveLength(1);
    expect(seen).toEqual([{ method: 'prefs.changed', params: {} }]);
  });
});

describe('lifecycle', () => {
  it('does not poll with zero subscribers', async () => {
    await timers.advance(10_000);
    expect(sources.scans).toBe(0);
    expect(timers.pending).toBe(0);
  });

  it('starts with the first subscriber and stops with the last', async () => {
    const first = await feed.subscribe(() => undefined);
    const second = await feed.subscribe(() => undefined);
    expect(feed.running).toBe(true);
    first();
    expect(feed.running).toBe(true);
    second();
    expect(feed.running).toBe(false);
    expect(sources.closed).toBe(true);
    const scans = sources.scans;
    await timers.advance(10_000);
    expect(sources.scans).toBe(scans);
  });

  it('takes a baseline at start, so existing runs are not reported as new', async () => {
    sources.runs.set('existing', 'lease');
    await feed.subscribe((n) => seen.push(n));
    await timers.advance(4_500);
    expect(seen).toEqual([]);
    expect(feed.liveRunIds()).toEqual(['existing']);
  });

  it('delivers to every subscriber', async () => {
    const other: ChangeNotification[] = [];
    await feed.subscribe((n) => seen.push(n));
    await feed.subscribe((n) => other.push(n));
    sources.token = 3;
    await timers.advance(2_250);
    expect(seen).toHaveLength(1);
    expect(other).toHaveLength(1);
  });
});

describe('real sources', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'yantra-feed-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('sees a commit from a separate SQLite connection through changeToken', async () => {
    // Arrange: the host's long-lived connection and a CLI's.
    const path = join(dir, 'index.db');
    const { db: hostDb } = await openIndexDb({ path });
    const { db: cliDb } = await openIndexDb({ path });
    const host = new SqliteHistoryStore({ db: hostDb });
    const cli = new SqliteHistoryStore({ db: cliDb });
    const real: ChangeSources = {
      scanRuns: () => Promise.resolve(new Map()),
      changeToken: () => {
        const token = host.changeToken();
        return token.isOk ? token.value : null;
      },
      profileStamp: () => Promise.resolve(null),
    };
    feed = new ChangeFeed({
      openSources: () => Promise.resolve(real),
      runsRoot: RUNS,
      profilePath: PROFILE,
      watch: watcher.fn,
      timers,
    });
    await feed.subscribe((n) => seen.push(n));

    // Act
    await cli.record({
      runId: 'from-cli',
      taskType: 'ask',
      intentText: 'q',
      briefId: null,
      status: 'succeeded',
      startedAt: '2026-11-11T10:00:00.000Z',
      finishedAt: '2026-11-11T10:00:01.000Z',
      durationMs: 1,
      costUsd: null,
      provider: null,
      taskOutcome: null,
    });
    await timers.advance(2_250);

    // Assert
    expect(seen.map((n) => n.method)).toEqual(['runs.changed']);
    hostDb.close();
    cliDb.close();
  });

  it('scans run directories and their leases', async () => {
    mkdirSync(join(dir, 'a'));
    mkdirSync(join(dir, 'b'));
    writeFileSync(join(dir, 'b', 'lease.json'), '{}');
    writeFileSync(join(dir, 'stray.txt'), 'x');
    const snapshot = await scanRunsDirectory(dir);
    expect([...snapshot.keys()].sort()).toEqual(['a', 'b']);
    expect(snapshot.get('a')).toBeNull();
    expect(snapshot.get('b')).toEqual(expect.any(String));
    expect(await scanRunsDirectory(join(dir, 'missing'))).toEqual(new Map());
  });

  it('stamps a file and returns null when it is absent', async () => {
    const file = join(dir, 'profile.yaml');
    expect(await fileStamp(file)).toBeNull();
    writeFileSync(file, 'a: 1');
    expect(await fileStamp(file)).toEqual(expect.any(String));
  });
});

describe('runs.subscribe', () => {
  function connection(id: number) {
    const sent: [string, Record<string, unknown>][] = [];
    const closers: (() => void)[] = [];
    return {
      sent,
      close: () => {
        for (const closer of closers) closer();
      },
      value: {
        id,
        windowId: `w${id}`,
        notify: (method: string, params: Record<string, unknown>) => sent.push([method, params]),
        onClose: (listener: () => void) => closers.push(listener),
      },
    };
  }

  it('forwards notifications to the socket and stops when it closes', async () => {
    // Arrange
    const methods = new RpcMethodRegistry();
    registerChangeFeed(methods, feed);
    const socket = connection(1);
    sources.runs.set('live', 'lease');
    const subscribe = methods.get('runs.subscribe')!;

    // Act
    const result = await subscribe.handler({}, { windowId: 'w1', connection: socket.value });
    await subscribe.handler({}, { windowId: 'w1', connection: socket.value }); // idempotent
    sources.token = 5;
    await timers.advance(2_250);
    socket.close();

    // Assert
    expect(result).toEqual({ live_run_ids: ['live'] });
    expect(socket.sent).toEqual([['runs.changed', { run_ids: [], live_run_ids: ['live'] }]]);
    expect(feed.running).toBe(false);
  });

  it('unsubscribes on runs.unsubscribe', async () => {
    const methods = new RpcMethodRegistry();
    registerChangeFeed(methods, feed);
    const socket = connection(2);
    await methods.get('runs.subscribe')!.handler({}, { windowId: 'w2', connection: socket.value });
    await methods
      .get('runs.unsubscribe')!
      .handler({}, { windowId: 'w2', connection: socket.value });
    expect(feed.running).toBe(false);
  });
});
