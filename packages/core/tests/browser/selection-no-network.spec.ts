/**
 * The selection surface is local. All of it.
 *
 * `browser list`, `browser use`, `browser check`, and `doctor` must make zero
 * update-metadata requests and zero downloads. Every one of those failures is
 * silent — an accidental metadata fetch produces no exception and no log line,
 * it just makes an offline machine hang or a private one phone home — so the
 * guarantee gets its own standing assertions at the boundary rather than an
 * inline check inside a feature task.
 *
 * The boundary is asserted by *failing* on any attempt: `fetch`, `https.request`,
 * and `http.request` are all replaced with throwing spies, so a request cannot
 * be missed by inspecting output.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ConfigBrowserSelectionReader,
  writeBrowserSelection,
} from '../../src/browser/config-selection.js';
import { doctor } from '../../src/browser/doctor.js';
import type { BrowserRuntimeServices } from '../../src/browser/installation-types.js';
import { LocalBrowserInventoryService } from '../../src/browser/inventory.js';
import { resetPathCache } from '../../src/browser/paths.js';
import { validateSelectablePath } from '../../src/browser/selection-validation.js';

/** Replaces every outbound transport with a throwing spy. */
function sealNetwork(): { readonly attempts: string[]; readonly restore: () => void } {
  const attempts: string[] = [];
  const fail = (what: string) => (): never => {
    attempts.push(what);
    throw new Error(`${what} is forbidden on the local browser selection surface`);
  };
  const spies = [
    vi.spyOn(globalThis, 'fetch').mockImplementation(fail('fetch') as never),
    vi.spyOn(https, 'request').mockImplementation(fail('https.request') as never),
    vi.spyOn(https, 'get').mockImplementation(fail('https.get') as never),
    vi.spyOn(http, 'request').mockImplementation(fail('http.request') as never),
    vi.spyOn(http, 'get').mockImplementation(fail('http.get') as never),
  ];
  return { attempts, restore: () => spies.forEach((spy) => spy.mockRestore()) };
}

function services(): BrowserRuntimeServices & { readonly probes: () => number } {
  let probes = 0;
  const bag = {
    resolver: {
      resolve: vi.fn().mockResolvedValue({
        status: 'unavailable',
        error: Object.assign(new Error('No Chrome or Chromium installation was found.'), {
          code: 'missing' as const,
          requestedSelection: { source: 'auto' as const, executablePath: null },
          evidence: {},
          remediation: 'Run `yantra browser install`.',
        }),
      }),
    },
    compatibility: {
      check: vi.fn(() => {
        probes += 1;
        return Promise.reject(new Error('the local surface must not probe'));
      }),
      decide: vi.fn(() => {
        probes += 1;
        return Promise.reject(new Error('the local surface must not probe'));
      }),
      readCached: vi.fn().mockResolvedValue({ state: 'unverified' }),
    },
    coordinator: {
      reserveUse: vi.fn(),
      claimMutation: vi.fn(),
      hasActiveUse: vi.fn().mockResolvedValue(false),
    },
    managedState: {
      readReady: vi.fn().mockResolvedValue({ status: 'absent' }),
      readInventory: vi.fn().mockResolvedValue({ ready: { status: 'absent' }, orphans: [] }),
    },
    // Present but must never be reached: a local command that quietly grew an
    // acquisition path would otherwise look identical from the outside.
    installService: {
      install: vi.fn(() => Promise.reject(new Error('install is forbidden here'))),
      collectOrphans: vi.fn(() => Promise.reject(new Error('collection is forbidden here'))),
    },
    installOfferGateway: null,
  } as unknown as BrowserRuntimeServices & { probes: () => number };
  Object.defineProperty(bag, 'probes', { value: () => probes });
  return bag;
}

describe('@no-llm browser selection surface is local', () => {
  let home: string;
  let configFile: string;
  const savedHome = process.env.YANTRA_HOME;
  let network: ReturnType<typeof sealNetwork>;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'yantra-no-network-'));
    process.env.YANTRA_HOME = home;
    resetPathCache();
    configFile = join(home, 'config.yaml');
    network = sealNetwork();
  });

  afterEach(async () => {
    network.restore();
    vi.restoreAllMocks();
    if (savedHome === undefined) delete process.env.YANTRA_HOME;
    else process.env.YANTRA_HOME = savedHome;
    resetPathCache();
    await rm(home, { recursive: true, force: true }).catch(() => undefined);
  });

  it('reads the inventory with no outbound request', async () => {
    const bag = services();
    const inventory = new LocalBrowserInventoryService({
      resolver: bag.resolver,
      managedState: bag.managedState,
      compatibility: bag.compatibility,
      discoverExternals: () => [],
    });

    await inventory.read();

    expect(network.attempts).toEqual([]);
    expect(bag.probes()).toBe(0);
  });

  it('runs doctor with no outbound request, no probe, and no collection', async () => {
    const bag = services();

    const report = await doctor({ refresh: true, services: bag });

    expect(report.checks.length).toBeGreaterThan(0);
    expect(network.attempts).toEqual([]);
    expect(bag.probes()).toBe(0);
    expect(bag.installService?.install).not.toHaveBeenCalled();
    expect(bag.installService?.collectOrphans).not.toHaveBeenCalled();
  });

  it('commits and reads a selection with no outbound request', async () => {
    await writeBrowserSelection({ source: 'managed', executablePath: null }, configFile);
    const reader = new ConfigBrowserSelectionReader({ configPath: configFile });

    await expect(reader.read()).resolves.toEqual({ source: 'managed', executablePath: null });
    expect(network.attempts).toEqual([]);
  });

  it('validates a custom path from the filesystem alone', async () => {
    const candidate = join(home, 'chrome');
    await writeFile(candidate, 'binary');

    await validateSelectablePath(candidate);

    expect(network.attempts).toEqual([]);
  });

  // The sealed boundary has to be able to fail, or every assertion above is
  // vacuous — this proves the spies actually intercept.
  it('fails loudly when something does try to reach the network', () => {
    // The seal throws synchronously, which is exactly what makes an accidental
    // request impossible to miss.
    expect(() => fetch('https://example.invalid/latest.json')).toThrow(/forbidden/u);
    expect(() => https.request('https://example.invalid/latest.json')).toThrow(/forbidden/u);
    expect(network.attempts).toEqual(['fetch', 'https.request']);
  });
});
