/**
 * Real `RecordingSession` startup, stop, and abort coverage.
 *
 * The existing recorder `session.spec.ts` exercises draft assembly and the
 * store; it never instantiates the session, so none of the lifecycle
 * guarantees below were covered before. Everything here drives the real class.
 */

import { EventEmitter } from 'node:events';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Browser, CDPSession } from 'puppeteer-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { BrowserCompatibilityError, BrowserResolutionError } from '../../../src/browser/errors.js';
import type {
  BrowserResolution,
  BrowserRuntimeServices,
  CompatibilityResult,
  ManagedReadyRecord,
  ResolvedBrowserInstallation,
} from '../../../src/browser/installation-types.js';
import type { OwnedBrowserProcess } from '../../../src/browser/launcher.js';
import type { OwnedManagedUseReservation } from '../../../src/browser/managed-coordination.js';
import type { BrowserProcessSupervisor } from '../../../src/browser/process-lifecycle.js';
import { RecordingSession } from '../../../src/workflow/recorder/session.js';
import type { RecordingStore } from '../../../src/workflow/recorder/store.js';
import { beginMigrationBrowserFixture } from '../../helpers/migration-browser.js';

const READY_RECORD: ManagedReadyRecord = {
  schemaVersion: 1,
  installationId: 'abc123',
  browser: 'chrome',
  platform: 'linux',
  buildId: '153.0.8010.36',
  cacheRootRelative: 'installation-abc123',
  executableRelative: 'chrome/linux-153.0.8010.36/chrome-linux64/chrome',
  verifiedAt: '2026-09-12T00:00:00.000Z',
};

function installation(
  overrides: Partial<ResolvedBrowserInstallation> = {},
): ResolvedBrowserInstallation {
  return {
    canonicalPath: '/usr/bin/google-chrome',
    version: '153.0.8010.36',
    majorVersion: 153,
    platform: 'linux',
    architecture: 'x64',
    statFingerprint: '1:2:3:4',
    ownership: 'external',
    requestedSelection: { source: 'auto', executablePath: null },
    selectionOrigin: 'default',
    selectionReason: 'system-discovery',
    channel: 'stable',
    managedIdentity: null,
    ...overrides,
  };
}

function evidence(
  target: ResolvedBrowserInstallation,
  verdict: CompatibilityResult['verdict'] = { status: 'passed', pairing: 'capability-checked' },
): CompatibilityResult {
  return {
    schemaVersion: 1,
    identity: target,
    driverVersion: '25.10.0',
    testedBuild: '152.0.7977.75',
    probeRevision: 1,
    capabilityTableHash: 'hash',
    profile: 'recorder',
    checkedAt: '2026-09-13T00:00:00.000Z',
    capabilities: [
      { capability: 'pipe-version', status: 'passed', reason: null },
      {
        capability: 'recorder-binding',
        status: verdict.status === 'passed' ? 'passed' : 'failed',
        reason: verdict.status === 'passed' ? null : 'addBinding is unavailable',
      },
    ],
    verdict,
  };
}

class FakeChild extends EventEmitter {
  pid: number | undefined = 7777;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stderr = new EventEmitter();
}

interface Harness {
  readonly session: RecordingSession;
  readonly services: BrowserRuntimeServices;
  readonly events: string[];
  readonly store: RecordingStore & { readonly destroys: { keepProfile: boolean }[] };
  readonly browser: FakeBrowser;
  readonly recordingDir: string;
}

interface FakeBrowser {
  readonly puppeteer: Browser;
  readonly sessions: FakeCdpSession[];
  readonly emitter: EventEmitter;
  disconnect(): void;
}

class FakeCdpSession extends EventEmitter {
  detached = false;
  readonly sent: string[] = [];

  constructor(
    private readonly targetId: string,
    private readonly failOn?: string,
  ) {
    super();
  }

  send(method: string): Promise<unknown> {
    this.sent.push(method);
    if (this.failOn === method) return Promise.reject(new Error(`${method} is unsupported`));
    if (method === 'Target.getTargetInfo')
      return Promise.resolve({ targetInfo: { targetId: this.targetId } });
    if (method === 'Browser.getVersion')
      return Promise.resolve({ product: 'HeadlessChrome/153.0.8010.36' });
    return Promise.resolve({});
  }

  detach(): Promise<void> {
    this.detached = true;
    return Promise.resolve();
  }
}

describe('@no-llm RecordingSession lifecycle', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'yantra-recorder-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function makeHarness(
    opts: {
      resolution?: BrowserResolution;
      compatibility?: CompatibilityResult;
      reserveError?: Error;
      launchError?: Error;
      shutdownError?: Error;
      failCdp?: string;
      failNewPage?: boolean;
      failPopupInstall?: boolean;
    } = {},
  ): Harness {
    const events: string[] = [];
    const recordingDir = join(root, 'recording');
    const destroys: { keepProfile: boolean }[] = [];

    const store = Object.assign(
      {
        create: () => {
          events.push('store:create');
          return Promise.resolve({ recordingDir });
        },
        saveDraft: (_id: string, _draft: unknown) => {
          events.push('store:saveDraft');
          return Promise.resolve(join(recordingDir, 'draft.json'));
        },
        destroy: (_id: string, o: { keepProfile: boolean }) => {
          events.push(`store:destroy:${String(o.keepProfile)}`);
          destroys.push(o);
          return Promise.resolve();
        },
      },
      { destroys },
    ) as unknown as RecordingStore & { destroys: { keepProfile: boolean }[] };

    const cdpSessions: FakeCdpSession[] = [];
    const browserEmitter = new EventEmitter();
    const target = {
      createCDPSession: () => {
        const session = new FakeCdpSession('browser-target', opts.failCdp);
        cdpSessions.push(session);
        return Promise.resolve(session as unknown as CDPSession);
      },
    };
    const page = {
      createCDPSession: () => {
        const session = new FakeCdpSession('main-target', opts.failCdp);
        cdpSessions.push(session);
        return Promise.resolve(session as unknown as CDPSession);
      },
      url: () => 'about:blank',
      on: vi.fn(),
    };
    const puppeteerBrowser = Object.assign(browserEmitter, {
      target: () => target,
      newPage: () => {
        if (opts.failNewPage) return Promise.reject(new Error('could not open the recording page'));
        return Promise.resolve(page);
      },
      pages: () => Promise.resolve([page]),
      close: () => Promise.resolve(),
      process: () => child,
    }) as unknown as Browser;

    const child = new FakeChild();
    const reservation: OwnedManagedUseReservation = {
      id: 'res-1',
      installationId: 'abc123',
      phase: 'starting',
      attachChild: () => {
        events.push('reservation:attach');
        return Promise.resolve();
      },
      releaseAfterExit: () => {
        events.push('reservation:release');
        return Promise.resolve();
      },
      markNeverSpawned: () => {
        events.push('reservation:never-spawned');
        return Promise.resolve();
      },
    };

    const launched: OwnedBrowserProcess = {
      browser: puppeteerBrowser,
      child: child as never,
      supervisor: {
        hasExited: () => child.exitCode !== null,
        whenExited: () => Promise.resolve(),
        shutdown: () => {
          events.push('process:terminate');
          return Promise.resolve();
        },
      } as unknown as BrowserProcessSupervisor,
      ownership: { kind: 'external' },
      shutdown: () => {
        events.push('process:shutdown');
        return opts.shutdownError ? Promise.reject(opts.shutdownError) : Promise.resolve();
      },
    };

    const resolved = opts.resolution ?? {
      status: 'resolved' as const,
      installation: installation(),
    };
    const services: BrowserRuntimeServices = {
      resolver: {
        resolve: vi.fn((selection) => {
          events.push(`resolve:${selection ? selection.source : 'default'}`);
          return Promise.resolve(resolved);
        }),
      },
      compatibility: {
        check: vi.fn((target: ResolvedBrowserInstallation, options) => {
          events.push(`compatibility:${options.profile}`);
          return Promise.resolve(opts.compatibility ?? evidence(target));
        }),
        readCached: vi.fn().mockResolvedValue({ state: 'unverified' }),
      },
      coordinator: {
        reserveUse: vi.fn(() => {
          events.push('reservation:acquire');
          if (opts.reserveError) return Promise.reject(opts.reserveError);
          return Promise.resolve(reservation);
        }),
        claimMutation: vi.fn(),
        hasActiveUse: vi.fn().mockResolvedValue(false),
      },
      managedState: {
        readReady: vi.fn().mockResolvedValue({ status: 'ready', record: READY_RECORD }),
        readInventory: vi
          .fn()
          .mockResolvedValue({ ready: { status: 'ready', record: READY_RECORD }, orphans: [] }),
      },
    };

    const session = new RecordingSession({
      store,
      services,
      launch: vi.fn((_options, _target, profile) => {
        events.push(`launch:${profile.kind}:${profile.absolutePath}`);
        if (opts.launchError) return Promise.reject(opts.launchError);
        return Promise.resolve(launched);
      }) as never,
    });

    if (opts.failPopupInstall) {
      // The popup handler installs through the browser CDP session; a failure
      // there is a startup failure, not a degraded recording.
      vi.spyOn(target, 'createCDPSession').mockImplementation(() => {
        const failing = new FakeCdpSession('browser-target', 'Target.setDiscoverTargets');
        cdpSessions.push(failing);
        return Promise.resolve(failing as unknown as CDPSession);
      });
    }

    return {
      session,
      services,
      events,
      store,
      recordingDir,
      browser: {
        puppeteer: puppeteerBrowser,
        sessions: cdpSessions,
        emitter: browserEmitter,
        disconnect: () => browserEmitter.emit('disconnected'),
      },
    };
  }

  describe('startup', () => {
    it('resolves, verifies the recorder profile, and launches visibly', async () => {
      const harness = makeHarness();

      const handle = await harness.session.start('invoices');

      expect(handle.recordingId).toBeTruthy();
      expect(harness.events).toContain('compatibility:recorder');
      // The recording profile is the Yantra-owned directory, never a personal one.
      expect(harness.events).toContain(`launch:explicit:${join(harness.recordingDir, 'profile')}`);
      await harness.session.stop('user');
    });

    it('requires recorder compatibility, not merely automation evidence', async () => {
      const harness = makeHarness();

      await harness.session.start('invoices');

      expect(harness.services.compatibility.check).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ profile: 'recorder' }),
      );
      await harness.session.stop('user');
    });

    it.each([
      ['system', { source: 'system' as const, executablePath: null }],
      ['managed', { source: 'managed' as const, executablePath: null }],
    ])('passes a %s selection to the shared resolver', async (_label, selection) => {
      const harness = makeHarness();

      await harness.session.start('invoices', { browserSelection: selection });

      expect(harness.services.resolver.resolve).toHaveBeenCalledWith(selection);
      await harness.session.stop('user');
    });

    it('starts from a custom executable through the one selection contract', async () => {
      const harness = makeHarness();

      await harness.session.start('invoices', {
        browserSelection: { source: 'system', executablePath: '/opt/chrome/chrome' },
      });

      expect(harness.services.resolver.resolve).toHaveBeenCalledWith({
        source: 'system',
        executablePath: '/opt/chrome/chrome',
      });
      await harness.session.stop('user');
    });

    it.each(['managed', 'system'] as const)(
      'starts from a persisted %s selection with no legacy translation left',
      async (source) => {
        const harness = makeHarness();
        const selection = { source, executablePath: null } as const;

        await harness.session.start('invoices', { browserSelection: selection });

        expect(harness.services.resolver.resolve).toHaveBeenCalledWith(selection);
        await harness.session.stop('user');
      },
    );

    it('resolves from the configured selection when the caller supplies none', async () => {
      const harness = makeHarness();

      await harness.session.start('invoices', {});

      // Undefined, not a fabricated `auto`: the resolver is what decides whether
      // the answer came from config or from the default.
      expect(harness.services.resolver.resolve).toHaveBeenCalledWith(undefined);
      await harness.session.stop('user');
    });

    it('fails with the resolver’s error when no browser is available', async () => {
      const error = new BrowserResolutionError({
        code: 'missing',
        message: 'No Chrome or Chromium installation was found.',
        requestedSelection: { source: 'auto', executablePath: null },
        remediation: 'Install Chrome or run `yantra browser install`.',
      });
      const harness = makeHarness({ resolution: { status: 'unavailable', error } });

      await expect(harness.session.start('invoices')).rejects.toBe(error);
      expect(harness.events).not.toContain('compatibility:recorder');
    });

    it('refuses to record when a recorder capability fails', async () => {
      const target = installation();
      const harness = makeHarness({
        compatibility: evidence(target, {
          status: 'failed',
          failureClass: 'capability-failure',
          remediation: 'Install a current Chrome or Chromium.',
        }),
      });

      const error = await harness.session.start('invoices').catch((e: unknown) => e);

      expect(error).toBeInstanceOf(BrowserCompatibilityError);
      expect((error as Error).message).toContain('recorder-binding');
      // No browser was ever started, so no user navigation was possible.
      expect(harness.events.some((e) => e.startsWith('launch:'))).toBe(false);
    });

    it('releases a managed reservation when compatibility refuses the browser', async () => {
      const managed = installation({ ownership: 'managed', managedIdentity: READY_RECORD });
      const harness = makeHarness({
        resolution: { status: 'resolved', installation: managed },
        compatibility: evidence(managed, {
          status: 'failed',
          failureClass: 'capability-failure',
          remediation: 'Install a current Chrome or Chromium.',
        }),
      });

      await expect(harness.session.start('invoices')).rejects.toBeInstanceOf(
        BrowserCompatibilityError,
      );

      // No browser was started, so the reservation is returned with the
      // never-spawned proof rather than leaked until the process exits.
      expect(harness.events).toContain('reservation:acquire');
      expect(harness.events).toContain('reservation:never-spawned');
    });

    it('rolls back and stays startable when the launch itself fails', async () => {
      const harness = makeHarness({ launchError: new Error('spawn ENOENT') });

      await expect(harness.session.start('invoices')).rejects.toThrow(/spawn ENOENT/);

      // The session returned to idle rather than pretending recording began.
      await expect(harness.session.stop('user')).rejects.toThrow(/invalid state: idle/);
    });

    it('rolls back the browser when opening the recording page fails', async () => {
      const harness = makeHarness({ failNewPage: true });

      await expect(harness.session.start('invoices')).rejects.toThrow(/recording page/);

      expect(harness.events).toContain('process:shutdown');
    });

    it('rolls back the browser when a CDP startup command fails', async () => {
      const harness = makeHarness({ failCdp: 'Runtime.addBinding' });

      await expect(harness.session.start('invoices')).rejects.toThrow(/Runtime.addBinding/);

      expect(harness.events).toContain('process:shutdown');
      expect(harness.browser.sessions.every((s) => s.detached)).toBe(true);
    });

    it('rolls back the browser when the popup handler cannot install', async () => {
      const harness = makeHarness({ failPopupInstall: true });

      await expect(harness.session.start('invoices')).rejects.toThrow();

      expect(harness.events).toContain('process:shutdown');
    });

    it('never deletes the recording directory on a failed startup', async () => {
      const harness = makeHarness({ launchError: new Error('spawn ENOENT') });

      await expect(harness.session.start('invoices')).rejects.toThrow();

      expect(harness.store.destroys).toEqual([]);
    });

    it('refuses a second start while recording', async () => {
      const harness = makeHarness();
      await harness.session.start('invoices');

      await expect(harness.session.start('again')).rejects.toThrow(/invalid state: recording/);
      await harness.session.stop('user');
    });
  });

  describe('stop and abort', () => {
    it('writes the draft, closes the browser, and destroys the profile', async () => {
      const harness = makeHarness();
      await harness.session.start('invoices');

      const { draftPath } = await harness.session.stop('user');

      expect(draftPath).toContain('draft.json');
      expect(harness.events).toContain('store:saveDraft');
      expect(harness.events).toContain('process:shutdown');
      expect(harness.events).toContain('store:destroy:false');
    });

    it('honors keepProfile on a successful stop', async () => {
      const harness = makeHarness();
      await harness.session.start('invoices', { keepProfile: true });

      await harness.session.stop('user');

      expect(harness.store.destroys).toEqual([{ keepProfile: true }]);
    });

    it('closes the browser exactly once across repeated stops', async () => {
      const harness = makeHarness();
      await harness.session.start('invoices');

      await harness.session.stop('user');
      await expect(harness.session.stop('user')).rejects.toThrow(/invalid state: stopped/);

      expect(harness.events.filter((e) => e === 'process:shutdown')).toHaveLength(1);
      expect(harness.store.destroys).toHaveLength(1);
    });

    it('preserves the profile on abort and still accounts for the process', async () => {
      const harness = makeHarness();
      await harness.session.start('invoices');

      const { draftPath } = await harness.session.abort('internal_error');

      expect(draftPath).toContain('draft.json');
      // Abort keeps the profile for post-mortem: no destroy at all.
      expect(harness.store.destroys).toEqual([]);
      expect(harness.events).toContain('process:terminate');
      expect(harness.events).toContain('process:shutdown');
    });

    it('writes a partial draft when the browser disconnects mid-recording', async () => {
      const harness = makeHarness();
      const handle = await harness.session.start('invoices');

      harness.browser.disconnect();
      const done = await handle.done;

      expect(done.stopReason).toBe('crash');
      expect(harness.events).toContain('store:saveDraft');
    });

    it('is idempotent across repeated aborts', async () => {
      const harness = makeHarness();
      await harness.session.start('invoices');

      await harness.session.abort('internal_error');
      await harness.session.abort('internal_error');

      expect(harness.events.filter((e) => e === 'process:shutdown')).toHaveLength(1);
    });

    it('detaches every recorder CDP session on stop', async () => {
      const harness = makeHarness();
      await harness.session.start('invoices');

      await harness.session.stop('user');

      expect(harness.browser.sessions.length).toBeGreaterThan(0);
      expect(harness.browser.sessions.some((s) => s.detached)).toBe(true);
    });

    it('does not release ownership twice when a stop follows an abort', async () => {
      const harness = makeHarness();
      await harness.session.start('invoices');

      await harness.session.abort('browser_disconnected');
      await expect(harness.session.stop('user')).rejects.toThrow(/invalid state/);

      expect(harness.events.filter((e) => e === 'process:shutdown')).toHaveLength(1);
    });
  });
});

// ---------------------------------------------------------------------------
// Real visible startup/stop smoke
// ---------------------------------------------------------------------------

describe.runIf(process.env['YANTRA_E2E_BROWSER'] === '1')(
  '@no-llm RecordingSession against a real browser',
  () => {
    let fixture: Awaited<ReturnType<typeof beginMigrationBrowserFixture>>;

    beforeAll(async () => {
      fixture = await beginMigrationBrowserFixture({ requireProvisioned: true });
    });

    afterAll(async () => {
      await fixture?.cleanup();
    });

    it('starts a visible recording browser and stops it cleanly', async () => {
      const session = new RecordingSession();

      const handle = await session.start('smoke-recording', {
        browserSelection: fixture.selection!,
        startupTimeoutMs: 60_000,
      });

      // The isolated recording profile exists while recording is live.
      await expect(stat(join(handle.recordingDir, 'profile'))).resolves.toBeTruthy();

      const { draftPath } = await session.stop('user');

      expect(draftPath).toContain('draft.json');
      // The Yantra-owned recording profile is gone; no developer profile was
      // ever touched, because the fixture sandboxes YANTRA_HOME.
      await expect(stat(join(handle.recordingDir, 'profile'))).rejects.toThrow();
      expect(handle.recordingDir.startsWith(fixture.yantraHome)).toBe(true);
    }, 180_000);
  },
);
