/**
 * `yantra browser list` is a local inventory.
 *
 * It exits 0 even for a broken selection — failing is the job of a launching
 * command and of `browser check` — and terminal and JSON must report the same
 * ownership, path, and version for the same state, because two renderers that
 * disagree are worse than one that is merely terse.
 */

import { BrowserResolutionError } from '@yantra/core';
import type {
  BrowserInventory,
  BrowserInventoryService,
  BrowserRuntimeServices,
  ResolvedBrowserInstallation,
} from '@yantra/core';
import { describe, expect, it, vi } from 'vitest';

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

const MANAGED_EXE = '/home/u/.yantra/data/browsers/installation-one/chrome/chrome';
const EXTERNAL_EXE = '/opt/google/chrome/chrome';

function installation(
  overrides: Partial<ResolvedBrowserInstallation> = {},
): ResolvedBrowserInstallation {
  return {
    canonicalPath: MANAGED_EXE,
    version: '153.0.8010.36',
    majorVersion: 153,
    platform: 'linux',
    architecture: 'x64',
    statFingerprint: '1:2:3:4',
    ownership: 'managed',
    requestedSelection: { source: 'auto', executablePath: null },
    selectionOrigin: 'default',
    selectionReason: 'managed-preferred',
    channel: 'stable',
    managedIdentity: null,
    ...overrides,
  };
}

function inventory(overrides: Partial<BrowserInventory> = {}): BrowserInventory {
  const target = installation();
  return {
    configured: undefined,
    override: undefined,
    effective: {
      status: 'resolved',
      installation: target,
      compatibility: { state: 'unverified' },
      recorderCompatibility: { state: 'unverified' },
    },
    managed: {
      status: 'ready',
      record: {
        schemaVersion: 1,
        installationId: 'one',
        browser: 'chrome',
        platform: 'linux',
        buildId: '153.0.8010.36',
        cacheRootRelative: 'installation-one',
        executableRelative: 'chrome/chrome',
        verifiedAt: '2026-09-14T00:00:00.000Z',
      },
    },
    alternatives: [
      {
        ownership: 'managed',
        executablePath: MANAGED_EXE,
        version: '153.0.8010.36',
        channel: 'stable',
        isEffective: true,
      },
    ],
    orphans: { count: 0, reclaimableBytes: 0 },
    managedRoot: '/home/u/.yantra/data/browsers',
    driver: { version: '25.10.0', testedBuild: '152.0.7977.75' },
    ...overrides,
  };
}

function services(view: BrowserInventory): {
  readonly bag: BrowserRuntimeServices;
  readonly reads: () => number;
} {
  let reads = 0;
  const projection: BrowserInventoryService = {
    read: () => {
      reads += 1;
      return Promise.resolve(view);
    },
  };
  const bag = {
    resolver: { resolve: () => Promise.reject(new Error('list must use the inventory')) },
    compatibility: {
      check: () => Promise.reject(new Error('list must not probe')),
      readCached: () => Promise.resolve({ state: 'unverified' as const }),
    },
    coordinator: {
      reserveUse: () => Promise.reject(new Error('list takes no reservation')),
      claimMutation: vi.fn(),
      hasActiveUse: () => Promise.resolve(false),
    },
    managedState: {
      readReady: () => Promise.resolve({ status: 'absent' as const }),
      readInventory: () => Promise.resolve({ ready: { status: 'absent' as const }, orphans: [] }),
    },
    inventory: projection,
  } as unknown as BrowserRuntimeServices;
  return { bag, reads: () => reads };
}

async function runList(view: BrowserInventory, json: boolean) {
  const stdout = sink();
  const stderr = sink();
  const composed = services(view);
  await makeBrowserCommand({
    services: composed.bag,
    stdout: stdout.stream,
    stderr: stderr.stream,
  }).parseAsync(json ? ['list', '--json'] : ['list'], { from: 'user' });
  return { stdout: stdout.text(), stderr: stderr.text(), reads: composed.reads() };
}

describe('@no-llm browser list command', () => {
  it('reads the shared inventory projection rather than building its own view', async () => {
    const result = await runList(inventory(), true);
    expect(result.reads).toBe(1);
  });

  it('marks exactly one entry effective when resolution succeeds', async () => {
    const result = await runList(
      inventory({
        alternatives: [
          {
            ownership: 'managed',
            executablePath: MANAGED_EXE,
            version: '153.0.8010.36',
            channel: 'stable',
            isEffective: true,
          },
          {
            ownership: 'external',
            executablePath: EXTERNAL_EXE,
            version: '152.0.7977.84',
            channel: 'stable',
            isEffective: false,
          },
        ],
      }),
      true,
    );
    const payload = JSON.parse(result.stdout) as {
      alternatives: readonly { isEffective: boolean }[];
    };
    expect(payload.alternatives.filter((entry) => entry.isEffective)).toHaveLength(1);
  });

  it('reports a configured selection as config rather than default', async () => {
    const result = await runList(
      inventory({
        configured: { source: 'system', executablePath: EXTERNAL_EXE },
        effective: {
          status: 'resolved',
          installation: installation({
            canonicalPath: EXTERNAL_EXE,
            ownership: 'external',
            selectionOrigin: 'config',
            selectionReason: 'custom-path',
            requestedSelection: { source: 'system', executablePath: EXTERNAL_EXE },
          }),
          compatibility: { state: 'unverified' },
          recorderCompatibility: { state: 'unverified' },
        },
      }),
      true,
    );
    expect(JSON.parse(result.stdout)).toMatchObject({
      selection: { source: 'system', executablePath: EXTERNAL_EXE, origin: 'config' },
    });
  });

  it('reports no configured block as the default selection', async () => {
    const result = await runList(inventory(), true);
    expect(JSON.parse(result.stdout)).toMatchObject({
      selection: { source: 'auto', executablePath: null, origin: 'default' },
    });
  });

  it('renders a broken selection with its remediation and still exits 0', async () => {
    // A real error, not a look-alike: the production class appends its
    // remediation to `message`, and a bare-message double would hide a renderer
    // that prints the remediation twice.
    const error = new BrowserResolutionError({
      code: 'managed-state-invalid',
      message: 'The ready pointer is malformed.',
      requestedSelection: { source: 'managed', executablePath: null },
      remediation: 'Run `yantra browser install`.',
    });

    const result = await runList(
      inventory({
        effective: { status: 'unavailable', error },
        alternatives: [
          {
            ownership: 'external',
            executablePath: EXTERNAL_EXE,
            version: '152.0.7977.84',
            channel: 'stable',
            isEffective: false,
          },
        ],
      }),
      false,
    );

    // Reaching here at all means exit 0 — parseAsync would have rejected.
    expect(result.stdout).toContain('unavailable');
    expect(result.stdout).toContain(EXTERNAL_EXE);
    expect(result.stderr).toContain('yantra browser install');
  });

  it('reports orphan count and reclaimable bytes without deleting anything', async () => {
    const result = await runList(
      inventory({ orphans: { count: 2, reclaimableBytes: 3072 } }),
      true,
    );
    expect(JSON.parse(result.stdout)).toMatchObject({
      orphans: { count: 2, reclaimableBytes: 3072 },
    });
  });

  it('reports an absent managed installation honestly', async () => {
    const result = await runList(
      inventory({
        managed: { status: 'absent' },
        effective: {
          status: 'resolved',
          installation: installation({
            canonicalPath: EXTERNAL_EXE,
            ownership: 'external',
            managedIdentity: null,
          }),
          compatibility: { state: 'unverified' },
          recorderCompatibility: { state: 'unverified' },
        },
      }),
      false,
    );
    expect(result.stdout).toContain('Managed: not installed');
  });

  it('reports the same ownership, path, and version in terminal and JSON', async () => {
    const view = inventory();
    const terminal = await runList(view, false);
    const json = await runList(view, true);
    const payload = JSON.parse(json.stdout) as {
      effective: { ownership: string; executablePath: string; version: string };
    };

    expect(terminal.stdout).toContain(payload.effective.ownership);
    expect(terminal.stdout).toContain(payload.effective.executablePath);
    expect(terminal.stdout).toContain(payload.effective.version);
  });

  it('emits exactly one JSON line', async () => {
    const result = await runList(inventory(), true);
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
  });

  it('opens no socket', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await runList(inventory(), true);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
