/**
 * Change detection for the app (FEAT-065 TASK-008): CLI, daemon and app runs
 * appear in an open window without a reload.
 *
 * Three sources, the first two authoritative:
 *
 * 1. a **lease scan** of `runs/*` every 2 s: which runs exist and which hold a
 *    `lease.json` (its mtime is the signature);
 * 2. the history index **change token** (`PRAGMA data_version` on one
 *    long-lived connection), polled every 2 s;
 * 3. `fs.watch` on the runs directory and on `profile.yaml`'s directory, as
 *    **hints only**: a hint triggers an immediate scan.
 *
 * Changes are debounced 250 ms into `runs.changed {run_ids, live_run_ids}` or
 * `prefs.changed`. The feed runs only while it has a subscriber; a watcher
 * error degrades to polling and is logged once.
 */

import { watch } from 'node:fs';
import { mkdir, readdir, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { RUN_LEASE_FILENAME } from '@yantra/core';
import { EmptyParams, RunsSubscribeResult } from '@yantra/protocol';

import { openHistory } from '../../history.js';

import { SILENT_HOST_LOGGER, type HostLogger } from './host.js';
import type { RpcMethodRegistry } from './rpc-server.js';

/** Poll interval of the authoritative sources. */
export const CHANGE_POLL_MS = 2_000;
/** Debounce window for notifications. */
export const CHANGE_DEBOUNCE_MS = 250;

/** One notification the feed emits. */
export type ChangeNotification =
  | {
      readonly method: 'runs.changed';
      readonly params: { readonly run_ids: string[]; readonly live_run_ids: string[] };
    }
  | { readonly method: 'prefs.changed'; readonly params: Record<string, never> };

/** A snapshot of the runs directory: run ID → lease signature, or null without a lease. */
export type RunSnapshot = ReadonlyMap<string, string | null>;

/** Where the feed reads from; injected so tests drive every source. */
export interface ChangeSources {
  scanRuns(): Promise<RunSnapshot>;
  /** The index change token, or null when the index is unavailable. */
  changeToken(): number | null;
  /** A signature of `profile.yaml` (mtime and size), or null when absent. */
  profileStamp(): Promise<string | null>;
  /** Releases long-lived handles (the index connection). */
  close?(): void;
}

/** A watcher handle as `fs.watch` returns it. */
export interface Watcher {
  close(): void;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

/** Starts a watcher; may throw (an unsupported filesystem). */
export type WatchFn = (path: string, listener: (filename: string | null) => void) => Watcher;

/** Timer functions, injected for a stepped clock. */
export interface FeedTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export const REAL_FEED_TIMERS: FeedTimers = {
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    handle.unref();
    return handle;
  },
  clearTimeout: (handle) => {
    clearTimeout(handle as NodeJS.Timeout);
  },
  setInterval: (callback, ms) => {
    const handle = setInterval(callback, ms);
    handle.unref();
    return handle;
  },
  clearInterval: (handle) => {
    clearInterval(handle as NodeJS.Timeout);
  },
};

export interface ChangeFeedDeps {
  /** Opens the sources when the first subscriber arrives. */
  readonly openSources: () => Promise<ChangeSources>;
  readonly runsRoot: string;
  readonly profilePath: string;
  readonly watch?: WatchFn;
  readonly timers?: FeedTimers;
  readonly logger?: HostLogger;
  readonly pollMs?: number;
  readonly debounceMs?: number;
}

type Listener = (notification: ChangeNotification) => void;

const defaultWatch: WatchFn = (path, listener) =>
  watch(path, { persistent: false }, (_event, filename) => {
    listener(filename === null ? null : String(filename));
  });

/** The change feed; see the module comment. */
export class ChangeFeed {
  private readonly listeners = new Set<Listener>();
  private readonly timers: FeedTimers;
  private readonly logger: HostLogger;
  private sources: ChangeSources | null = null;
  private starting: Promise<void> | null = null;
  private interval: unknown = null;
  private debounce: unknown = null;
  private watchers: Watcher[] = [];
  private degradedLogged = false;
  private scanning: Promise<void> | null = null;
  private rescan = false;
  private generation = 0;

  private runs: RunSnapshot = new Map();
  private token: number | null = null;
  private profile: string | null = null;
  private pendingRuns = new Set<string>();
  private pendingRunsChanged = false;
  private pendingPrefs = false;

  public constructor(private readonly deps: ChangeFeedDeps) {
    this.timers = deps.timers ?? REAL_FEED_TIMERS;
    this.logger = deps.logger ?? SILENT_HOST_LOGGER;
  }

  /** True while at least one subscriber keeps the feed running. */
  public get running(): boolean {
    return this.sources !== null;
  }

  /** Runs with a lease at the last scan. */
  public liveRunIds(): string[] {
    return [...this.runs]
      .filter(([, lease]) => lease !== null)
      .map(([runId]) => runId)
      .sort();
  }

  /**
   * Adds a subscriber, starting the feed for the first one. Resolves once the
   * baseline is taken; returns the unsubscribe function.
   */
  public async subscribe(listener: Listener): Promise<() => void> {
    this.listeners.add(listener);
    if (this.sources === null) {
      this.starting ??= this.start().finally(() => {
        this.starting = null;
      });
      await this.starting;
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stop();
    };
  }

  /** Drops every subscriber and stops (host shutdown). */
  public close(): void {
    this.listeners.clear();
    this.stop();
  }

  /** Scans now (also what a watcher hint does). Concurrent calls coalesce. */
  public async scan(): Promise<void> {
    if (this.sources === null) return;
    if (this.scanning !== null) {
      this.rescan = true;
      return this.scanning;
    }
    this.scanning = this.scanOnce().finally(() => {
      this.scanning = null;
    });
    await this.scanning;
    if (this.rescan) {
      this.rescan = false;
      await this.scan();
    }
  }

  private async start(): Promise<void> {
    const generation = ++this.generation;
    const sources = await this.deps.openSources();
    if (generation !== this.generation || this.listeners.size === 0) {
      sources.close?.();
      return;
    }
    this.sources = sources;
    this.runs = await sources.scanRuns();
    this.token = sources.changeToken();
    this.profile = await sources.profileStamp();
    this.interval = this.timers.setInterval(() => {
      void this.scan().catch((error: unknown) => {
        this.logger.warn({ reason: errorName(error) }, 'change scan failed');
      });
    }, this.deps.pollMs ?? CHANGE_POLL_MS);
    this.startWatchers();
  }

  private stop(): void {
    this.generation += 1;
    if (this.interval !== null) this.timers.clearInterval(this.interval);
    if (this.debounce !== null) this.timers.clearTimeout(this.debounce);
    this.interval = null;
    this.debounce = null;
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
    this.sources?.close?.();
    this.sources = null;
    this.pendingRuns.clear();
    this.pendingRunsChanged = false;
    this.pendingPrefs = false;
  }

  private startWatchers(): void {
    const watchFn = this.deps.watch ?? defaultWatch;
    const profileName = basename(this.deps.profilePath);
    const targets: [string, (filename: string | null) => boolean][] = [
      [this.deps.runsRoot, () => true],
      [dirname(this.deps.profilePath), (filename) => filename === null || filename === profileName],
    ];
    for (const [path, relevant] of targets) {
      try {
        const watcher = watchFn(path, (filename) => {
          if (relevant(filename)) void this.scan().catch(() => undefined);
        });
        watcher.on('error', (error) => {
          this.degrade(error);
        });
        this.watchers.push(watcher);
      } catch (error) {
        this.degrade(error);
      }
    }
  }

  private degrade(error: unknown): void {
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
    if (!this.degradedLogged) {
      this.degradedLogged = true;
      this.logger.warn(
        { reason: (error as NodeJS.ErrnoException).code ?? errorName(error) },
        'file watching unavailable; change detection is polling only',
      );
    }
  }

  private async scanOnce(): Promise<void> {
    const sources = this.sources;
    if (sources === null) return;
    const runs = await sources.scanRuns();
    const token = sources.changeToken();
    const profile = await sources.profileStamp();
    if (this.sources !== sources) return;

    for (const [runId, lease] of runs) {
      if (!this.runs.has(runId) || this.runs.get(runId) !== lease) this.pendingRuns.add(runId);
    }
    for (const runId of this.runs.keys()) if (!runs.has(runId)) this.pendingRuns.add(runId);
    if (this.pendingRuns.size > 0) this.pendingRunsChanged = true;
    if (token !== this.token) this.pendingRunsChanged = true;
    if (profile !== this.profile) this.pendingPrefs = true;
    this.runs = runs;
    this.token = token;
    this.profile = profile;
    if ((this.pendingRunsChanged || this.pendingPrefs) && this.debounce === null) {
      this.debounce = this.timers.setTimeout(() => {
        this.debounce = null;
        this.flush();
      }, this.deps.debounceMs ?? CHANGE_DEBOUNCE_MS);
    }
  }

  private flush(): void {
    const notifications: ChangeNotification[] = [];
    if (this.pendingRunsChanged) {
      notifications.push({
        method: 'runs.changed',
        params: { run_ids: [...this.pendingRuns].sort(), live_run_ids: this.liveRunIds() },
      });
    }
    if (this.pendingPrefs) notifications.push({ method: 'prefs.changed', params: {} });
    this.pendingRuns.clear();
    this.pendingRunsChanged = false;
    this.pendingPrefs = false;
    for (const notification of notifications) {
      for (const listener of [...this.listeners]) listener(notification);
    }
  }
}

/** Reads `runs/*` and each run's `lease.json` mtime. */
export async function scanRunsDirectory(root: string): Promise<RunSnapshot> {
  let names: string[];
  try {
    names = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return new Map();
  }
  const entries = await Promise.all(
    names.map(async (name): Promise<[string, string | null] | null> => {
      try {
        const lease = await stat(join(root, name, RUN_LEASE_FILENAME));
        return [name, `${lease.mtimeMs}:${lease.size}`];
      } catch (error) {
        // No lease (ENOENT); any other failure leaves the run unreported this scan.
        return (error as NodeJS.ErrnoException).code === 'ENOENT' ? [name, null] : null;
      }
    }),
  );
  return new Map(entries.filter((entry): entry is [string, string | null] => entry !== null));
}

/** `profile.yaml`'s mtime and size, or null when absent. */
export async function fileStamp(path: string): Promise<string | null> {
  try {
    const info = await stat(path);
    return `${info.mtimeMs}:${info.size}`;
  } catch {
    return null;
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

/** The production sources: one long-lived index connection, the runs directory, profile.yaml. */
export async function openDefaultSources(paths: {
  readonly runsRoot: string;
  readonly profilePath: string;
}): Promise<ChangeSources> {
  await mkdir(paths.runsRoot, { recursive: true, mode: 0o700 });
  const history = await openHistory();
  return {
    scanRuns: () => scanRunsDirectory(paths.runsRoot),
    changeToken: () => {
      const token = history?.store.changeToken();
      return token?.isOk === true ? token.value : null;
    },
    profileStamp: () => fileStamp(paths.profilePath),
    close: () => {
      history?.close();
    },
  };
}

/**
 * Registers `runs.subscribe` and `runs.unsubscribe`. A socket's subscription
 * ends when it closes; the feed stops with its last subscriber.
 */
export function registerChangeFeed(methods: RpcMethodRegistry, feed: ChangeFeed): void {
  const subscriptions = new Map<number, () => void>();
  methods.register('runs.subscribe', {
    params: EmptyParams,
    result: RunsSubscribeResult,
    handler: async (_params, { connection }) => {
      if (!subscriptions.has(connection.id)) {
        const unsubscribe = await feed.subscribe((notification) => {
          connection.notify(notification.method, notification.params);
        });
        subscriptions.set(connection.id, unsubscribe);
        connection.onClose(() => {
          subscriptions.get(connection.id)?.();
          subscriptions.delete(connection.id);
        });
      }
      return { live_run_ids: feed.liveRunIds() };
    },
  });
  methods.register('runs.unsubscribe', {
    params: EmptyParams,
    result: EmptyParams,
    handler: (_params, { connection }) => {
      subscriptions.get(connection.id)?.();
      subscriptions.delete(connection.id);
      return {};
    },
  });
}
