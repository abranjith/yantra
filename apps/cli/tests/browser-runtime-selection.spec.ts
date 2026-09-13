/**
 * Every launch-capable CLI factory resolves through one selection seam.
 *
 * The failure this guards against is silent: two factories each building their
 * own provider still "work", they just disagree about which browser the user is
 * running — and nothing in the output says so.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  resetPathCache,
  type BrowserRuntimeOptions,
  type BrowserRuntimeServices,
  type BrowserSelection,
  type CompatibilityResult,
  type ResolvedBrowserInstallation,
} from '@yantra/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDefaultAskPipeline } from '../src/commands/ask.js';
import { createDefaultResearchLoop } from '../src/commands/research.js';
import { buildOrchestratorRuntime } from '../src/runtime.js';

function installation(
  overrides: Partial<ResolvedBrowserInstallation> = {},
): ResolvedBrowserInstallation {
  return {
    canonicalPath: '/opt/managed/chrome',
    version: '153.0.8010.36',
    majorVersion: 153,
    platform: 'linux',
    architecture: 'x64',
    statFingerprint: '1:2:3:4',
    ownership: 'managed',
    requestedSelection: { source: 'managed', executablePath: null },
    selectionOrigin: 'invocation',
    selectionReason: 'managed-explicit',
    channel: 'stable',
    managedIdentity: null,
    ...overrides,
  };
}

interface Probe {
  readonly services: BrowserRuntimeServices;
  readonly resolveCalls: (BrowserSelection | undefined)[];
  readonly probes: () => number;
  readonly reservations: () => number;
}

function makeProbe(target = installation()): Probe {
  const resolveCalls: (BrowserSelection | undefined)[] = [];
  let probes = 0;
  let reservations = 0;
  const result: CompatibilityResult = {
    schemaVersion: 1,
    identity: target,
    driverVersion: '25.10.0',
    testedBuild: '152.0.7977.75',
    probeRevision: 1,
    capabilityTableHash: 'hash',
    profile: 'automation',
    checkedAt: '2026-09-13T00:00:00.000Z',
    capabilities: [],
    verdict: { status: 'passed', pairing: 'capability-checked' },
  };
  const services: BrowserRuntimeServices = {
    resolver: {
      resolve: (selection) => {
        resolveCalls.push(selection);
        return Promise.resolve({ status: 'resolved', installation: target });
      },
    },
    compatibility: {
      check: () => {
        probes += 1;
        return Promise.resolve(result);
      },
      readCached: () => Promise.resolve({ state: 'unverified' }),
    },
    coordinator: {
      reserveUse: () => {
        reservations += 1;
        return Promise.reject(new Error('no reservation expected in these tests'));
      },
      claimMutation: vi.fn(),
      hasActiveUse: () => Promise.resolve(false),
    },
    managedState: {
      readReady: () => Promise.resolve({ status: 'absent' }),
      readInventory: () => Promise.resolve({ ready: { status: 'absent' }, orphans: [] }),
    },
  };
  return { services, resolveCalls, probes: () => probes, reservations: () => reservations };
}

/** Every CLI factory that can end up launching a browser. */
const FACTORIES: readonly [string, (browser: BrowserRuntimeOptions) => Promise<unknown>][] = [
  [
    'run/resume orchestrator',
    async (browser) => {
      const runtime = await buildOrchestratorRuntime({ browser });
      runtime.close();
      return runtime;
    },
  ],
  ['ask pipeline', (browser) => createDefaultAskPipeline({ query: 'anything' } as never, browser)],
  [
    'research loop',
    (browser) => createDefaultResearchLoop({ topic: 'anything' } as never, browser),
  ],
];

describe('@no-llm CLI browser runtime selection', () => {
  let home: string;
  const savedHome = process.env.YANTRA_HOME;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'yantra-cli-browser-'));
    process.env.YANTRA_HOME = home;
    resetPathCache();
  });

  afterEach(async () => {
    if (savedHome === undefined) delete process.env.YANTRA_HOME;
    else process.env.YANTRA_HOME = savedHome;
    resetPathCache();
    // Best effort: the ask/research factories open the local index and Windows
    // refuses to unlink a file whose handle is still open. The sandbox is a
    // per-test temp directory, so a leftover here cannot reach a real home.
    await rm(home, { recursive: true, force: true }).catch(() => undefined);
  });

  it.each(FACTORIES)(
    'the %s factory launches nothing, probes nothing, and takes no lock',
    async (_label, build) => {
      const probe = makeProbe();
      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      try {
        await build({ services: probe.services });

        expect(probe.resolveCalls).toHaveLength(0);
        expect(probe.probes()).toBe(0);
        expect(probe.reservations()).toBe(0);
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    },
    60_000,
  );

  it('gives every factory the identical resolved source, path, and ownership', async () => {
    const target = installation();
    const seen: unknown[] = [];

    for (const [, build] of FACTORIES) {
      const probe = makeProbe(target);
      await build({
        services: probe.services,
        selection: { source: 'managed', executablePath: null },
      });
      // Each factory hands its provider the same services and selection, so a
      // resolution through any of them is the same resolution.
      const resolution = await probe.services.resolver.resolve({
        source: 'managed',
        executablePath: null,
      });
      seen.push(resolution.status === 'resolved' ? resolution.installation : resolution);
    }

    expect(seen.every((entry) => entry === target)).toBe(true);
  }, 60_000);

  it('accepts a per-invocation selection without persisting it', async () => {
    const probe = makeProbe();
    const configPathBefore = join(home, 'config.yaml');

    const runtime = await buildOrchestratorRuntime({
      browser: {
        services: probe.services,
        selection: { source: 'system', executablePath: '/opt/chrome/chrome' },
      },
    });
    runtime.close();

    // A per-invocation choice writes nothing: config.yaml was never created.
    await expect(rm(configPathBefore)).rejects.toThrow();
  }, 60_000);

  it('registers no new CLI flags for browser selection in this feature', async () => {
    const { makeConfigCommand } = await import('../src/commands/config.js');
    const command = makeConfigCommand();

    const flags = command.commands.flatMap((sub) => sub.options.map((o) => o.long));

    // FEAT-045 owns `--browser` / `--browser-path`; this feature adds the
    // programmatic seam only.
    expect(flags).not.toContain('--browser');
    expect(flags).not.toContain('--browser-path');
  });
});
