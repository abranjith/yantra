/**
 * The agent runtime resolves browsers through the shared selection seam.
 *
 * The guarantee is source consistency: every launch-capable path in a run —
 * agent tools, browser fetch, scraped search — must get the same source, path,
 * and ownership, and constructing the runtime must not start a browser, probe
 * one, or touch an update boundary.
 */

import {
  createSelectedBrowserProvider,
  type BrowserRuntimeServices,
  type BrowserSelection,
  type CompatibilityResult,
  type ResolvedBrowserInstallation,
} from '@yantra/core';
import { describe, expect, it, vi } from 'vitest';

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

function evidence(target: ResolvedBrowserInstallation): CompatibilityResult {
  return {
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
}

interface Probe {
  readonly services: BrowserRuntimeServices;
  readonly resolveCalls: (BrowserSelection | undefined)[];
  readonly probes: number;
  readonly network: number;
}

function makeServices(target = installation()): Probe {
  const resolveCalls: (BrowserSelection | undefined)[] = [];
  let probes = 0;
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
        return Promise.resolve(evidence(target));
      },
      readCached: () => Promise.resolve({ state: 'unverified' }),
    },
    coordinator: {
      reserveUse: vi.fn(),
      claimMutation: vi.fn(),
      hasActiveUse: () => Promise.resolve(false),
    },
    managedState: {
      readReady: () => Promise.resolve({ status: 'absent' }),
      readInventory: () => Promise.resolve({ ready: { status: 'absent' }, orphans: [] }),
    },
  };
  return {
    services,
    resolveCalls,
    get probes() {
      return probes;
    },
    network: 0,
  };
}

describe('@no-llm agent runtime browser selection', () => {
  it('constructs a provider without launching, probing, or reaching the network', async () => {
    const probe = makeServices();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    try {
      const provider = createSelectedBrowserProvider({ services: probe.services });

      expect(provider).toBeDefined();
      // Construction alone resolves nothing and probes nothing: the browser
      // starts only when a tool actually asks for a page.
      expect(probe.resolveCalls).toHaveLength(0);
      expect(probe.probes).toBe(0);
      expect(fetchSpy).not.toHaveBeenCalled();
      await Promise.resolve();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('reports the same identity to every launch-capable consumer', async () => {
    const target = installation({ ownership: 'managed', selectionReason: 'managed-preferred' });
    const probe = makeServices(target);
    const provider = createSelectedBrowserProvider({ services: probe.services });

    // The agent controller, the browser fetcher, and scraped search all hold
    // this one provider, so asking it twice must give one answer.
    const first = await provider.detectChrome();
    const second = await provider.detectChrome();

    expect(first).toEqual(second);
    expect(first).toMatchObject({ path: target.canonicalPath, source: 'managed' });
  });

  it.each([
    ['managed', { source: 'managed' as const, executablePath: null }],
    ['system', { source: 'system' as const, executablePath: null }],
    ['custom path', { source: 'system' as const, executablePath: '/opt/chrome/chrome' }],
  ])('applies a %s invocation selection to the shared resolver', async (_label, selection) => {
    const probe = makeServices();
    const provider = createSelectedBrowserProvider({ services: probe.services, selection });

    await provider.detectChrome();

    expect(probe.resolveCalls).toEqual([selection]);
  });

  it('does not persist a per-invocation override', async () => {
    const probe = makeServices();
    const overridden = createSelectedBrowserProvider({
      services: probe.services,
      selection: { source: 'managed', executablePath: null },
    });
    await overridden.detectChrome();

    // A provider built afterwards without a selection falls back to config/auto.
    const plain = createSelectedBrowserProvider({ services: probe.services });
    await plain.detectChrome();

    expect(probe.resolveCalls).toEqual([{ source: 'managed', executablePath: null }, undefined]);
  });

  it('keeps a resolution failure as its typed cause at the runtime boundary', async () => {
    const probe = makeServices();
    const error = Object.assign(new Error('No Chrome or Chromium installation was found.'), {
      code: 'missing' as const,
      requestedSelection: { source: 'auto' as const, executablePath: null },
      evidence: {},
      remediation: 'Install Chrome or run `yantra browser install`.',
    });
    probe.services.resolver.resolve = () => Promise.resolve({ status: 'unavailable', error });
    const provider = createSelectedBrowserProvider({ services: probe.services });

    const thrown = await provider
      .launch({ profile: { kind: 'ephemeral' } })
      .catch((e: unknown) => e);

    expect(thrown).toBe(error);
    expect((thrown as { code: string }).code).toBe('missing');
    expect((thrown as { remediation: string }).remediation).toContain('yantra browser install');
  });

  it('adds no model-visible browser installation or update capability', async () => {
    const probe = makeServices();

    const provider = createSelectedBrowserProvider({ services: probe.services });

    // The provider a tool can reach exposes selection and launch, and nothing
    // that could provision a browser.
    const surface = [
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(provider) as object),
      ...Object.keys(provider),
    ];
    expect(surface).toContain('launch');
    expect(surface).toContain('detectChrome');
    for (const name of surface) {
      expect(name).not.toMatch(/install|update|download|provision/i);
    }

    // And the shared services carry no download or update boundary at all.
    const serviceSurface = Object.keys(probe.services).flatMap((key) =>
      Object.keys(probe.services[key as keyof BrowserRuntimeServices] as object),
    );
    for (const name of serviceSurface) {
      expect(name).not.toMatch(/install|update|download|fetchMetadata/i);
    }
    await Promise.resolve();
  });
});
