import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CompatibilityCache,
  compatibilityCacheKey,
} from '../../src/browser/compatibility-cache.js';
import {
  DRIVER_COMPATIBILITY,
  capabilityTableHash,
} from '../../src/browser/driver-compatibility.js';
import type {
  CompatibilityResult,
  DriverCompatibilityDescriptor,
  ExecutableIdentity,
  ProbeProfile,
} from '../../src/browser/installation-types.js';

function identity(overrides: Partial<ExecutableIdentity> = {}): ExecutableIdentity {
  return {
    canonicalPath: '/opt/chrome/chrome',
    version: '153.0.8010.36',
    majorVersion: 153,
    platform: 'linux',
    architecture: 'x64',
    statFingerprint: '100:200:300:400',
    ...overrides,
  };
}

function passing(
  profile: ProbeProfile = 'automation',
  overrides: Partial<CompatibilityResult> = {},
): CompatibilityResult {
  return {
    schemaVersion: 1,
    identity: identity(),
    driverVersion: DRIVER_COMPATIBILITY.driverVersion,
    testedBuild: DRIVER_COMPATIBILITY.testedBuild,
    probeRevision: DRIVER_COMPATIBILITY.probeRevision,
    capabilityTableHash: capabilityTableHash(),
    profile,
    checkedAt: '2026-09-13T00:00:00.000Z',
    capabilities: [{ capability: 'pipe-version', status: 'passed', reason: null }],
    verdict: { status: 'passed', pairing: 'capability-checked' },
    ...overrides,
  };
}

describe('@no-llm compatibility cache key', () => {
  it.each([
    ['a different executable', identity({ canonicalPath: '/usr/bin/chromium' })],
    ['a different version', identity({ version: '152.0.7977.75' })],
    ['a changed stat fingerprint', identity({ statFingerprint: '999:200:300:400' })],
    ['a different platform', identity({ platform: 'darwin' })],
    ['a different architecture', identity({ architecture: 'arm64' })],
  ])('changes for %s', (_label, changed) => {
    expect(compatibilityCacheKey(changed, 'automation')).not.toBe(
      compatibilityCacheKey(identity(), 'automation'),
    );
  });

  it('changes for a different probe profile', () => {
    expect(compatibilityCacheKey(identity(), 'recorder')).not.toBe(
      compatibilityCacheKey(identity(), 'automation'),
    );
  });

  it.each([
    ['a driver bump', { driverVersion: '26.0.0' }],
    ['a probe-revision bump', { probeRevision: DRIVER_COMPATIBILITY.probeRevision + 1 }],
  ])('changes for %s', (_label, patch) => {
    const descriptor = { ...DRIVER_COMPATIBILITY, ...patch } as DriverCompatibilityDescriptor;
    expect(compatibilityCacheKey(identity(), 'automation', descriptor)).not.toBe(
      compatibilityCacheKey(identity(), 'automation'),
    );
  });

  it('changes when the capability table is edited, even with no revision bump', () => {
    // This is the invariant that makes a forgotten revision bump harmless: the
    // table's own hash is part of the key.
    const edited: DriverCompatibilityDescriptor = {
      ...DRIVER_COMPATIBILITY,
      capabilities: [
        ...DRIVER_COMPATIBILITY.capabilities,
        {
          id: 'pipe-version',
          why: 'an added requirement',
          requiredBy: ['automation'],
          dependsOn: [],
        },
      ],
    };

    expect(capabilityTableHash(edited)).not.toBe(capabilityTableHash());
    expect(compatibilityCacheKey(identity(), 'automation', edited)).not.toBe(
      compatibilityCacheKey(identity(), 'automation'),
    );
  });

  it('is stable for the same question', () => {
    expect(compatibilityCacheKey(identity(), 'automation')).toBe(
      compatibilityCacheKey(identity(), 'automation'),
    );
  });
});

describe('@no-llm CompatibilityCache', () => {
  let root: string;
  let cache: CompatibilityCache;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'yantra-compat-'));
    cache = new CompatibilityCache({ root: () => root });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('reports unverified when nothing has been recorded', async () => {
    await expect(cache.read(identity(), 'automation')).resolves.toEqual({ state: 'unverified' });
  });

  it('returns recorded successful evidence', async () => {
    await cache.write(passing());

    const state = await cache.read(identity(), 'automation');

    expect(state.state).toBe('evidence');
    expect(state.state === 'evidence' && state.result.verdict.status).toBe('passed');
  });

  it('never serves a failed result as evidence, though it retains it for diagnostics', async () => {
    await cache.write(
      passing('automation', {
        verdict: {
          status: 'failed',
          failureClass: 'capability-failure',
          remediation: 'install a newer Chrome',
        },
      }),
    );

    await expect(cache.read(identity(), 'automation')).resolves.toEqual({ state: 'unverified' });
    await expect(readdir(root)).resolves.toHaveLength(1);
  });

  it('does not let automation evidence approve recording', async () => {
    await cache.write(passing('automation'));

    await expect(cache.read(identity(), 'recorder')).resolves.toEqual({ state: 'unverified' });
  });

  it.each([
    ['the version changed', identity({ version: '152.0.7977.75' })],
    ['the binary was replaced in place', identity({ statFingerprint: 'changed' })],
    ['the host platform changed', identity({ platform: 'win32' })],
    ['the architecture changed', identity({ architecture: 'arm64' })],
  ])('invalidates evidence when %s', async (_label, changed) => {
    await cache.write(passing());

    await expect(cache.read(changed, 'automation')).resolves.toEqual({ state: 'unverified' });
  });

  it('rejects malformed cache content rather than trusting it', async () => {
    const key = compatibilityCacheKey(identity(), 'automation');
    await writeFile(join(root, `${key}.json`), '{"schemaVersion": 1, "verdict": "yes"}', 'utf8');

    await expect(cache.read(identity(), 'automation')).resolves.toEqual({ state: 'unverified' });
  });

  it('rejects unparseable cache content', async () => {
    const key = compatibilityCacheKey(identity(), 'automation');
    await writeFile(join(root, `${key}.json`), 'not json at all', 'utf8');

    await expect(cache.read(identity(), 'automation')).resolves.toEqual({ state: 'unverified' });
  });

  it('rejects a file whose recorded identity disagrees with its own key', async () => {
    // A hand-edited or colliding file must not answer for another executable.
    const key = compatibilityCacheKey(identity(), 'automation');
    await writeFile(
      join(root, `${key}.json`),
      JSON.stringify(
        passing('automation', { identity: identity({ canonicalPath: '/elsewhere' }) }),
      ),
      'utf8',
    );

    await expect(cache.read(identity(), 'automation')).resolves.toEqual({ state: 'unverified' });
  });

  it('invalidates on request', async () => {
    await cache.write(passing());
    await cache.invalidate(identity(), 'automation');

    await expect(cache.read(identity(), 'automation')).resolves.toEqual({ state: 'unverified' });
  });

  it('degrades to unverified rather than throwing when the cache root is unwritable', async () => {
    const broken = new CompatibilityCache({ root: () => join(root, 'file-not-dir', 'nested') });
    await writeFile(join(root, 'file-not-dir'), 'x');

    await expect(broken.write(passing())).resolves.toBeUndefined();
    await expect(broken.read(identity(), 'automation')).resolves.toEqual({ state: 'unverified' });
  });
});
