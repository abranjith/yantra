/**
 * The agent runtime resolves browsers through the shared selection seam.
 *
 * The guarantee is source consistency: every launch-capable path in a run —
 * agent tools, browser fetch, scraped search — must get the same source, path,
 * and ownership, and constructing the runtime must not start a browser, probe
 * one, or touch an update boundary.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BrowserResolutionError,
  createSelectedBrowserProvider,
  type BrowserRuntimeServices,
  type BrowserSelection,
  type CompatibilityResult,
  type ResolvedBrowserInstallation,
} from '@yantra/core';
import { describe, expect, it, vi } from 'vitest';

import { COMMAND_TASK_PROFILES } from '../../src/runtime/profiles.js';

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
      decide: () => {
        probes += 1;
        return Promise.resolve({ result: evidence(target), evidenceSource: 'probe' as const });
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
    // The real exported class, not a structural stand-in: the startup mapper
    // classifies by `instanceof`, so a double that merely satisfies the shape
    // would be reported as an unexpected fault and this test would prove the
    // opposite of what it claims.
    const error = new BrowserResolutionError({
      code: 'missing',
      message: 'No Chrome or Chromium installation was found.',
      requestedSelection: { source: 'auto', executablePath: null },
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
    const names = [
      ...new Set(Object.values(COMMAND_TASK_PROFILES).flatMap((profile) => profile.toolNames)),
    ];
    expect(names).toContain('browser_navigate');
    expect(names.filter((name) => /install|update|download|provision/i.test(name))).toEqual([]);
    await Promise.resolve();
  });

  it('hands a launch its own logger, so provenance lands where the run can read it', async () => {
    const probe = makeServices();
    const lines: Record<string, unknown>[] = [];
    const record = (obj: Record<string, unknown> | string): void => {
      lines.push(typeof obj === 'string' ? { msg: obj } : obj);
    };
    const logger = { info: record, warn: record, error: record, debug: record };
    // The real exported class, not a structural stand-in: the startup mapper
    // classifies by `instanceof`, so a double that merely satisfies the shape
    // would be reported as an unexpected fault and this test would prove the
    // opposite of what it claims.
    const error = new BrowserResolutionError({
      code: 'missing',
      message: 'No Chrome or Chromium installation was found.',
      requestedSelection: { source: 'auto', executablePath: null },
      remediation: 'Install Chrome or run `yantra browser install`.',
    });
    probe.services.resolver.resolve = () => Promise.resolve({ status: 'unavailable', error });
    const provider = createSelectedBrowserProvider({ services: probe.services, logger });

    await provider.launch({ profile: { kind: 'ephemeral' } }).catch(() => undefined);

    // Why the run could not open a browser is now recoverable from the run's
    // own logger. Before this feature the agent runtime handed every component
    // a no-op, so the answer existed only in the thrown error.
    const startup = lines.find((line) => line.event === 'browser_startup_failed');
    expect(startup).toMatchObject({ phase: 'resolution', failure_kind: 'resolution' });
    // And the remediation prose stays on the error, not in the durable log.
    expect(JSON.stringify(lines)).not.toContain('yantra browser install');
  });
});

/**
 * One run, one destination.
 *
 * `createDefaultEnvironment` composes roughly a dozen collaborators, and the
 * only way `runtime.jsonl` stays a single coherent append-only artifact is for
 * every one of them to receive the same bound logger. That is a property of the
 * composition, not of any single call, so it is asserted over the source: a
 * second `RunRuntimeLog.open` or a revived no-op logger is exactly the
 * regression that would be invisible at runtime until an operator read a file
 * with interleaved halves.
 */
describe('@no-llm agent runtime owns exactly one runtime destination', () => {
  const orchestratorSource = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../../src/runtime/orchestrator.ts'),
    'utf8',
  );

  it('opens the destination exactly once across the whole agent package', () => {
    const agentSrc = resolve(dirname(fileURLToPath(import.meta.url)), '../../src');
    const opens = collectTypeScriptFiles(agentSrc).flatMap((file) => {
      const text = readFileSync(file, 'utf8');
      return text.includes('RunRuntimeLog.open(') ? [file] : [];
    });

    expect(opens).toHaveLength(1);
    expect(opens[0]?.replaceAll('\\', '/')).toContain('src/runtime/orchestrator.ts');
    expect(orchestratorSource.split('RunRuntimeLog.open(')).toHaveLength(2);
  });

  it('binds the run logger once and hands it to every browser-capable factory', () => {
    expect(orchestratorSource).toContain('const logger = runtimeLog.logger;');
    // The no-op logger this replaced must not come back: a component that gets
    // it logs into nothing while its siblings log into the artifact.
    expect(orchestratorSource).not.toContain('info: () => undefined');

    for (const factory of [
      'createSelectedBrowserProvider(',
      'new LocalProfileStore(',
      'new AgentBrowserController(',
      'new RunOrchestrator(',
    ]) {
      const occurrences = orchestratorSource.split(factory).length - 1;
      expect(occurrences).toBeGreaterThan(0);
    }
    // Both the default and the nested-workflow provider composition pass it.
    const providerCalls = orchestratorSource
      .split('createSelectedBrowserProvider({')
      .slice(1)
      .map((tail) => tail.slice(0, tail.indexOf('});')));
    expect(providerCalls.length).toBeGreaterThanOrEqual(2);
    for (const call of providerCalls) expect(call).toContain('logger');
  });

  it('exposes the same logger to the tool middleware it gave the browser', () => {
    expect(orchestratorSource).toContain('runtimeLogger: logger');
    expect(orchestratorSource).toContain(
      '...(environment.runtimeLogger ? { runtimeLogger: environment.runtimeLogger } : {}),',
    );
  });
});

function collectTypeScriptFiles(root: string, into: string[] = []): string[] {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) collectTypeScriptFiles(full, into);
    else if (entry.isFile() && entry.name.endsWith('.ts')) into.push(full);
  }
  return into;
}
