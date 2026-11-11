import { open } from 'node:fs/promises';
import { join } from 'node:path';

import { RUN_LEASE_SCHEMA_VERSION, type OwnedBrowserEvent } from '@yantra/protocol';

import type { ProcessIdentity } from '../browser/installation-types.js';

import { OWNED_BROWSERS_FILENAME } from './constants.js';

/**
 * Records the browser processes a run owns, so a reconciler can reap one the
 * run left behind, by creation identity (FEAT-064).
 */
export interface BrowserOwnershipRecorder {
  /** Called as soon as a browser child handle exists; durable before it resolves. */
  recordSpawned(identity: ProcessIdentity): Promise<void>;
  /** Called only after the browser's exit is proved. */
  recordExited(identity: ProcessIdentity): Promise<void>;
}

/**
 * Appends to `<runDir>/owned-browsers.jsonl` and syncs before resolving.
 * Appends, unlike renames, survive a reader holding the file open on Windows
 * (spike S2, RC2). Appends are serialized, so lines keep call order.
 */
export class FileBrowserOwnershipRecorder implements BrowserOwnershipRecorder {
  private readonly path: string;
  private tail: Promise<void> = Promise.resolve();

  public constructor(
    runDir: string,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.path = join(runDir, OWNED_BROWSERS_FILENAME);
  }

  public recordSpawned(identity: ProcessIdentity): Promise<void> {
    return this.append('spawned', identity);
  }

  public recordExited(identity: ProcessIdentity): Promise<void> {
    return this.append('exited', identity);
  }

  private append(op: OwnedBrowserEvent['op'], identity: ProcessIdentity): Promise<void> {
    const line: OwnedBrowserEvent = {
      schema_version: RUN_LEASE_SCHEMA_VERSION,
      op,
      pid: identity.pid,
      start_token: identity.startToken,
      at: this.clock().toISOString(),
    };
    const next = this.tail.then(async () => {
      const file = await open(this.path, 'a', 0o600);
      try {
        await file.appendFile(`${JSON.stringify(line)}\n`, 'utf8');
        await file.sync();
      } finally {
        await file.close();
      }
    });
    this.tail = next.catch(() => undefined);
    return next;
  }
}

/**
 * A recorder whose destination is known only later: a browser provider built
 * before the run directory exists records through it, and the run binds it to
 * its session's recorder once it owns the run. Before `bind` there is no run
 * to own a browser, so calls are no-ops rather than waits that could hang a
 * launch.
 */
export class DeferredBrowserOwnershipRecorder implements BrowserOwnershipRecorder {
  private target: BrowserOwnershipRecorder | null = null;

  /** Directs every later call to `target`. */
  public bind(target: BrowserOwnershipRecorder): void {
    this.target = target;
  }

  public recordSpawned(identity: ProcessIdentity): Promise<void> {
    return this.target?.recordSpawned(identity) ?? Promise.resolve();
  }

  public recordExited(identity: ProcessIdentity): Promise<void> {
    return this.target?.recordExited(identity) ?? Promise.resolve();
  }
}
