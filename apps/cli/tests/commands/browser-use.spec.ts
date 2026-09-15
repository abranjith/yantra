/**
 * `yantra browser use` commits a selection without starting a browser.
 *
 * The property that matters most here is negative and silent when broken:
 * setting a preference must cost no browser launch and no probe. It is asserted
 * with `vi.spyOn` on the compatibility service *instance*, because an outer
 * decorator cannot observe a service's internal `this.method()` calls.
 */

import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BrowserResolutionError,
  LocalBrowserCompatibilityService,
  type BrowserResolution,
  type BrowserResolutionErrorCode,
  type BrowserRuntimeServices,
  type BrowserSelection,
  type CompatibilityEvidenceState,
  type CompatibilityResult,
  type ManagedReadySnapshot,
  type ResolvedBrowserInstallation,
} from '@yantra/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeBrowserCommand } from '../../src/commands/browser.js';

function sink() {
  let value = '';
  return {
    stream: {
      write: (chunk: string | Uint8Array) => {
        value += String(chunk);
        return true;
      },
    } as NodeJS.WritableStream,
    text: () => value,
  };
}

function installation(
  overrides: Partial<ResolvedBrowserInstallation> = {},
): ResolvedBrowserInstallation {
  return {
    canonicalPath: '/opt/google/chrome/chrome',
    version: '153.0.8010.36',
    majorVersion: 153,
    platform: 'linux',
    architecture: 'x64',
    statFingerprint: '1:2:3:4',
    ownership: 'external',
    requestedSelection: { source: 'system', executablePath: null },
    selectionOrigin: 'invocation',
    selectionReason: 'system-discovery',
    channel: 'stable',
    managedIdentity: null,
    ...overrides,
  };
}

function passedEvidence(target: ResolvedBrowserInstallation): CompatibilityResult {
  return {
    schemaVersion: 1,
    identity: target,
    driverVersion: '25.10.0',
    testedBuild: '152.0.7977.75',
    probeRevision: 1,
    capabilityTableHash: 'hash',
    profile: 'automation',
    checkedAt: '2026-09-14T00:00:00.000Z',
    capabilities: [],
    verdict: { status: 'passed', pairing: 'capability-checked' },
  };
}

interface Harness {
  readonly services: BrowserRuntimeServices;
  readonly compatibility: LocalBrowserCompatibilityService;
  readonly writes: BrowserSelection[];
  readonly launches: () => number;
  readonly resolveCalls: (BrowserSelection | undefined)[];
}

function harness(
  options: {
    readonly resolution?: BrowserResolution;
    readonly ready?: ManagedReadySnapshot;
    readonly cached?: CompatibilityEvidenceState;
  } = {},
): Harness {
  const resolveCalls: (BrowserSelection | undefined)[] = [];
  const writes: BrowserSelection[] = [];
  let launches = 0;

  // A *real* compatibility service, so `check`/`readCached` spies observe the
  // same instance the command uses. Its launch boundary counts spawns.
  const compatibility = new LocalBrowserCompatibilityService({
    launch: () => {
      launches += 1;
      return Promise.reject(new Error('no browser may be launched by `browser use`'));
    },
  });
  vi.spyOn(compatibility, 'readCached').mockResolvedValue(
    options.cached ?? { state: 'unverified' },
  );

  const services: BrowserRuntimeServices = {
    resolver: {
      resolve: (selection) => {
        resolveCalls.push(selection);
        return Promise.resolve(
          options.resolution ?? { status: 'resolved', installation: installation() },
        );
      },
    },
    compatibility,
    coordinator: {
      reserveUse: () => Promise.reject(new Error('no reservation expected')),
      claimMutation: vi.fn(),
      hasActiveUse: () => Promise.resolve(false),
    },
    managedState: {
      readReady: () => Promise.resolve(options.ready ?? { status: 'absent' }),
      readInventory: () =>
        Promise.resolve({ ready: options.ready ?? { status: 'absent' }, orphans: [] }),
    },
  };

  return {
    services,
    compatibility,
    writes,
    launches: () => launches,
    resolveCalls,
  };
}

function command(
  h: Harness,
  streams: { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream },
) {
  return makeBrowserCommand({
    services: h.services,
    writeSelection: (selection) => {
      h.writes.push(selection);
      return Promise.resolve();
    },
    stdout: streams.stdout,
    stderr: streams.stderr,
  });
}

describe('@no-llm browser use command', () => {
  let home: string;
  let realChrome: string;
  const savedHome = process.env.YANTRA_HOME;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'yantra-browser-use-'));
    process.env.YANTRA_HOME = home;
    realChrome = join(home, 'chrome-bin');
    await writeFile(realChrome, '#!/bin/sh\n');
    await chmod(realChrome, 0o755);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (savedHome === undefined) delete process.env.YANTRA_HOME;
    else process.env.YANTRA_HOME = savedHome;
    await rm(home, { recursive: true, force: true }).catch(() => undefined);
  });

  it.each(['auto', 'managed', 'system'] as const)('commits source %s', async (source) => {
    const stdout = sink();
    const stderr = sink();
    const h = harness({
      ready: { status: 'ready', record: readyRecord() },
    });

    await command(h, { stdout: stdout.stream, stderr: stderr.stream }).parseAsync(['use', source], {
      from: 'user',
    });

    expect(h.writes).toEqual([{ source, executablePath: null }]);
  });

  it('commits a custom path and reports it as the resolved installation', async () => {
    const stdout = sink();
    const stderr = sink();
    const h = harness({
      resolution: {
        status: 'resolved',
        installation: installation({ canonicalPath: realChrome, selectionReason: 'custom-path' }),
      },
    });

    await command(h, { stdout: stdout.stream, stderr: stderr.stream }).parseAsync(
      ['use', 'system', '--path', realChrome],
      { from: 'user' },
    );

    expect(h.writes).toEqual([{ source: 'system', executablePath: realChrome }]);
    expect(stdout.text()).toContain(realChrome);
    expect(stdout.text()).toContain('external');
  });

  it('reports a custom path at the ready managed executable as managed-owned', async () => {
    const stdout = sink();
    const stderr = sink();
    const h = harness({
      resolution: {
        status: 'resolved',
        installation: installation({
          canonicalPath: realChrome,
          ownership: 'managed',
          selectionReason: 'custom-path',
          managedIdentity: readyRecord(),
        }),
      },
      ready: { status: 'ready', record: readyRecord() },
    });

    await command(h, { stdout: stdout.stream, stderr: stderr.stream }).parseAsync(
      ['use', 'system', '--path', realChrome],
      { from: 'user' },
    );

    expect(stdout.text()).toContain('managed');
  });

  describe('validation', () => {
    it.each(['auto', 'managed'] as const)('rejects --path with source %s', async (source) => {
      const stdout = sink();
      const stderr = sink();
      const h = harness();
      await expect(
        command(h, { stdout: stdout.stream, stderr: stderr.stream }).parseAsync(
          ['use', source, '--path', realChrome],
          { from: 'user' },
        ),
      ).rejects.toMatchObject({ exitCode: 1 });
      expect(h.writes).toHaveLength(0);
    });

    it('rejects an unknown source', async () => {
      const stdout = sink();
      const stderr = sink();
      const h = harness();
      await expect(
        command(h, { stdout: stdout.stream, stderr: stderr.stream }).parseAsync(
          ['use', 'firefox'],
          { from: 'user' },
        ),
      ).rejects.toMatchObject({ exitCode: 1 });
    });

    // Every path failure gets its own message: two failures that read
    // identically send the user looking for the wrong thing.
    it('reports missing, directory, relative, and non-executable paths differently', async () => {
      const directory = join(home, 'a-directory');
      await mkdir(directory, { recursive: true });
      const notExecutable = join(home, 'not-executable');
      await writeFile(notExecutable, 'x');
      await chmod(notExecutable, 0o400);

      // The non-executable case only exists on POSIX: Windows has no execute
      // bit, so a readable `.exe` is as far as a non-launching check can go.
      const candidates = [join(home, 'does-not-exist'), directory, 'relative/chrome'];
      if (process.platform !== 'win32') candidates.push(notExecutable);

      const messages: string[] = [];
      for (const candidate of candidates) {
        const stdout = sink();
        const stderr = sink();
        const h = harness();
        await expect(
          command(h, { stdout: stdout.stream, stderr: stderr.stream }).parseAsync(
            ['use', 'system', '--path', candidate],
            { from: 'user' },
          ),
        ).rejects.toMatchObject({ exitCode: 1 });
        expect(h.writes).toHaveLength(0);
        messages.push(stderr.text());
      }

      expect(new Set(messages).size).toBe(messages.length);
    });

    it('fails `use managed` with no ready installation by naming install', async () => {
      const stdout = sink();
      const stderr = sink();
      const h = harness({
        resolution: {
          status: 'unavailable',
          error: resolutionError('missing', 'No Yantra-managed browser is installed.'),
        },
      });
      await expect(
        command(h, { stdout: stdout.stream, stderr: stderr.stream }).parseAsync(
          ['use', 'managed'],
          { from: 'user' },
        ),
      ).rejects.toMatchObject({ exitCode: 1 });
      expect(stderr.text()).toContain('yantra browser install');
      expect(h.writes).toHaveLength(0);
    });

    it('fails `use managed` on an invalid record with its reason, not a fallback', async () => {
      const stdout = sink();
      const stderr = sink();
      const h = harness({
        resolution: {
          status: 'unavailable',
          error: resolutionError(
            'managed-state-invalid',
            'The Yantra-managed browser record is unusable: ready pointer is not valid JSON.',
          ),
        },
      });
      await expect(
        command(h, { stdout: stdout.stream, stderr: stderr.stream }).parseAsync(
          ['use', 'managed'],
          { from: 'user' },
        ),
      ).rejects.toMatchObject({ exitCode: 1 });
      expect(stderr.text()).toContain('not valid JSON');
      expect(h.writes).toHaveLength(0);
    });

    it('rejects a custom path the resolver refuses, such as one into an orphan tree', async () => {
      const stdout = sink();
      const stderr = sink();
      const h = harness({
        resolution: {
          status: 'unavailable',
          error: resolutionError(
            'invalid-selection',
            'The selected path is inside the managed browser root but is not the ready installation.',
          ),
        },
      });
      await expect(
        command(h, { stdout: stdout.stream, stderr: stderr.stream }).parseAsync(
          ['use', 'system', '--path', realChrome],
          { from: 'user' },
        ),
      ).rejects.toMatchObject({ exitCode: 1 });
      expect(stderr.text()).toContain('not the ready installation');
      expect(h.writes).toHaveLength(0);
    });

    it('rejects a custom path that escapes the managed root through a symlink', async () => {
      const stdout = sink();
      const stderr = sink();
      const h = harness({
        resolution: {
          status: 'unavailable',
          error: resolutionError(
            'invalid-selection',
            'The selected path crosses the managed browser root through a symlink or junction.',
          ),
        },
      });
      await expect(
        command(h, { stdout: stdout.stream, stderr: stderr.stream }).parseAsync(
          ['use', 'system', '--path', realChrome],
          { from: 'user' },
        ),
      ).rejects.toMatchObject({ exitCode: 1 });
      expect(stderr.text()).toContain('symlink');
    });
  });

  describe('compatibility reporting', () => {
    it('reports unverified with the exact check command when no evidence exists', async () => {
      const stdout = sink();
      const stderr = sink();
      const h = harness({
        resolution: {
          status: 'resolved',
          installation: installation({ canonicalPath: realChrome }),
        },
      });

      await command(h, { stdout: stdout.stream, stderr: stderr.stream }).parseAsync(
        ['use', 'system', '--path', realChrome],
        { from: 'user' },
      );

      expect(stdout.text()).toContain('unverified');
      expect(stdout.text()).toContain(`yantra browser check --browser-path ${realChrome}`);
    });

    it('reports cached evidence as capability-checked', async () => {
      const stdout = sink();
      const stderr = sink();
      const target = installation();
      const h = harness({
        resolution: { status: 'resolved', installation: target },
        cached: { state: 'evidence', result: passedEvidence(target) },
      });

      await command(h, { stdout: stdout.stream, stderr: stderr.stream }).parseAsync(
        ['use', 'auto'],
        {
          from: 'user',
        },
      );

      expect(stdout.text()).toContain('capability-checked');
      expect(stdout.text()).not.toContain('yantra browser check');
    });

    it('reports tested when the build is the tested pairing', async () => {
      const stdout = sink();
      const stderr = sink();
      const target = installation({ version: '152.0.7977.75' });
      const evidence = passedEvidence(target);
      const h = harness({
        resolution: { status: 'resolved', installation: target },
        cached: {
          state: 'evidence',
          result: { ...evidence, verdict: { status: 'passed', pairing: 'tested' } },
        },
      });

      await command(h, { stdout: stdout.stream, stderr: stderr.stream }).parseAsync(
        ['use', 'auto'],
        {
          from: 'user',
        },
      );

      expect(stdout.text()).toContain('Compatibility: tested');
    });
  });

  it('spawns no browser process and runs no probe', async () => {
    const stdout = sink();
    const stderr = sink();
    const h = harness({
      resolution: {
        status: 'resolved',
        installation: installation({ canonicalPath: realChrome }),
      },
    });
    // Spied on the instance: an outer wrapper cannot see the service's own
    // internal `this.runProbe()` call.
    const check = vi.spyOn(h.compatibility, 'check');
    const probe = vi.spyOn(h.compatibility, 'runProbe');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await command(h, { stdout: stdout.stream, stderr: stderr.stream }).parseAsync(
      ['use', 'system', '--path', realChrome],
      { from: 'user' },
    );

    expect(check).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
    expect(h.launches()).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('emits exactly one JSON envelope on stdout', async () => {
    const stdout = sink();
    const stderr = sink();
    const h = harness({
      resolution: {
        status: 'resolved',
        installation: installation({ canonicalPath: realChrome }),
      },
    });

    await command(h, { stdout: stdout.stream, stderr: stderr.stream }).parseAsync(
      ['use', 'system', '--path', realChrome, '--json'],
      { from: 'user' },
    );

    const lines = stdout.text().trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      kind: 'browser_use',
      status: 'set',
      source: 'system',
      executablePath: realChrome,
      compatibility: 'unverified',
    });
  });
});

function readyRecord() {
  return {
    schemaVersion: 1 as const,
    installationId: 'one',
    browser: 'chrome' as const,
    platform: 'linux' as const,
    buildId: '153.0.8010.36',
    cacheRootRelative: 'installation-one',
    executableRelative: 'chrome/linux-153.0.8010.36/chrome-linux64/chrome',
    verifiedAt: '2026-09-14T00:00:00.000Z',
  };
}

/**
 * A real {@link BrowserResolutionError}, not a look-alike.
 *
 * The production class appends its remediation to `message`, so a hand-rolled
 * double with a bare message hides a duplicated-remediation bug in the renderer
 * instead of catching it.
 */
function resolutionError(code: BrowserResolutionErrorCode, message: string) {
  return new BrowserResolutionError({
    code,
    message,
    requestedSelection: { source: 'managed', executablePath: null },
    remediation: 'Run `yantra browser install` to install the managed Chrome for Testing build.',
  });
}
