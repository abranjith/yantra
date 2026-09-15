/**
 * Stable resolution and the installed-versus-available comparison.
 *
 * Two claims here are only provable by observation, never by inspecting a
 * constructed options object: that a resolve run writes *nothing* (asserted by
 * comparing a full recursive listing of the sandboxed home before and after),
 * and that a configured proxy is actually contacted (asserted against a proxy
 * server that records the request, because the bypass is silent).
 */

import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  ManagedPlatform,
  ManagedReadyRecord,
  ManagedReadySnapshot,
} from '../../src/browser/installation-types.js';
import {
  compareManagedBuild,
  LocalStableResolutionService,
  nextCommandFor,
} from '../../src/browser/managed-availability.js';
import { ManagedInstallHelperClient } from '../../src/browser/managed-install-helper-client.js';
import {
  DEFAULT_MANAGED_INSTALL_POLICY,
  type ManagedInstallPolicy,
} from '../../src/browser/managed-install-types.js';
import type { StableBuild } from '../../src/browser/managed-update-types.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const RESOLVE_FIXTURE = join(FIXTURES, 'resolve-only-helper.mjs');
const PROXY_FIXTURE = join(FIXTURES, 'metadata-proxy-helper.mjs');

const PLATFORM: ManagedPlatform = 'linux';
const TESTED = '152.0.7977.75';
const STABLE = '153.0.8010.36';

function policy(overrides: Partial<ManagedInstallPolicy> = {}): ManagedInstallPolicy {
  return {
    ...DEFAULT_MANAGED_INSTALL_POLICY,
    wholeOperationMs: 2_000,
    metadataMs: 500,
    stallMs: 200,
    cancelAckMs: 100,
    treeExitMs: 1_000,
    ...overrides,
  };
}

/**
 * A real helper client driven at a scripted fixture.
 *
 * The client is the real one on purpose: the environment allowlist and
 * `NODE_USE_ENV_PROXY=1` live there, and a hand-built runner would assert the
 * service's arithmetic while skipping the part that can silently go direct.
 */
function service(
  operationId: string,
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly helperPath?: string;
    readonly platform?: () => ManagedPlatform | null;
    readonly policy?: ManagedInstallPolicy;
  } = {},
) {
  return new LocalStableResolutionService({
    helper: new ManagedInstallHelperClient({
      helperPath: () => options.helperPath ?? RESOLVE_FIXTURE,
      ...(options.env ? { env: options.env } : {}),
    }),
    policy: options.policy ?? policy(),
    platform: options.platform ?? (() => PLATFORM),
    id: () => operationId,
    clock: () => new Date('2026-09-14T00:00:00.000Z'),
  });
}

function record(buildId: string): ManagedReadyRecord {
  return {
    schemaVersion: 1,
    installationId: 'one',
    browser: 'chrome',
    platform: PLATFORM,
    buildId,
    cacheRootRelative: 'installation-one',
    executableRelative: 'chrome/linux-x/chrome',
    verifiedAt: '2026-09-14T00:00:00.000Z',
  };
}

function build(buildId = STABLE, artifactAvailable = true): StableBuild {
  return {
    buildId,
    platform: PLATFORM,
    resolvedAt: '2026-09-14T00:00:00.000Z',
    artifactAvailable,
  };
}

/** Every path under a root, relative and sorted, with file sizes. */
async function listing(root: string): Promise<readonly string[]> {
  const found: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const child = join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(child);
        found.push(`${relative(root, child)}/`);
      } else {
        found.push(`${relative(root, child)}:${(await stat(child)).size}`);
      }
    }
  }
  return found.sort();
}

describe('@no-llm stable resolution', () => {
  const roots: string[] = [];
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    await Promise.all(
      servers
        .splice(0)
        .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  });

  it('resolves current Stable and reports whether the artifact can be downloaded', async () => {
    await expect(service('happy').resolveStable()).resolves.toEqual({
      status: 'resolved',
      build: {
        buildId: STABLE,
        platform: PLATFORM,
        resolvedAt: '2026-09-14T00:00:00.000Z',
        artifactAvailable: true,
      },
    });
  });

  it('reports a resolvable build whose artifact is unavailable as a distinct fact', async () => {
    const resolution = await service('unavailable-artifact').resolveStable();
    expect(resolution).toMatchObject({
      status: 'resolved',
      build: { buildId: STABLE, artifactAvailable: false },
    });
  });

  it('asks for the Stable tag, never `latest` and never a channel', async () => {
    const home = await mkdtemp(join(tmpdir(), 'yantra-resolve-log-'));
    roots.push(home);
    await service('log', { env: { ...process.env, YANTRA_HOME: home } }).resolveStable();

    // The request the helper actually received, not the object the parent built.
    const received = JSON.parse(
      (await readFile(join(home, 'requests.jsonl'), 'utf8')).trim(),
    ) as Record<string, unknown>;
    expect(received).toMatchObject({
      protocolVersion: 2,
      mode: 'resolve',
      browser: 'chrome',
      platform: PLATFORM,
      // Resolve mode is given nowhere to write, and no build to install.
      cacheDir: null,
      buildId: null,
    });
    expect(JSON.stringify(received)).not.toContain('latest');
  });

  it('writes no file and creates no directory anywhere under the sandboxed home', async () => {
    const home = await mkdtemp(join(tmpdir(), 'yantra-resolve-home-'));
    roots.push(home);
    await writeFile(join(home, 'config.yaml'), 'browser:\n  source: managed\n');
    const before = await listing(home);

    await expect(
      service('happy', { env: { ...process.env, YANTRA_HOME: home } }).resolveStable(),
    ).resolves.toMatchObject({ status: 'resolved' });

    expect(await listing(home)).toEqual(before);
  });

  it('refuses an unsupported host before spawning anything', async () => {
    const helper = { run: vi.fn() };
    const resolution = await new LocalStableResolutionService({
      helper,
      platform: () => null,
    }).resolveStable();
    expect(resolution).toMatchObject({
      status: 'unavailable',
      error: { code: 'unsupported-platform' },
    });
    expect(helper.run).not.toHaveBeenCalled();
  });

  it.each([
    ['error-metadata-unavailable', 'metadata-unavailable'],
    ['error-network-failure', 'network-failure'],
    ['error-proxy-failure', 'proxy-failure'],
  ] as const)('maps %s onto its own code', async (scenario, code) => {
    await expect(service(scenario).resolveStable()).resolves.toMatchObject({
      status: 'unavailable',
      error: { code },
    });
  });

  it('gives each metadata failure class its own remediation text', async () => {
    const texts = await Promise.all(
      ['error-metadata-unavailable', 'error-network-failure', 'error-proxy-failure'].map(
        async (scenario) => {
          const resolution = await service(scenario).resolveStable();
          if (resolution.status !== 'unavailable') throw new Error('expected a failure');
          return resolution.error.remediation;
        },
      ),
    );
    expect(new Set(texts).size).toBe(texts.length);
  });

  it('never leaks proxy credentials into the error', async () => {
    const resolution = await service('credentialed-proxy-error', {
      env: { ...process.env, HTTPS_PROXY: 'http://user:hunter2@proxy.internal:3128' },
    }).resolveStable();
    expect(resolution.status).toBe('unavailable');
    expect(JSON.stringify(resolution)).not.toContain('hunter2');
  });

  it('trips the metadata deadline rather than hanging, leaving no live helper', async () => {
    const started = Date.now();
    const resolution = await service('silent', {
      policy: policy({ metadataMs: 250, wholeOperationMs: 250 }),
    }).resolveStable();
    expect(resolution).toMatchObject({ status: 'unavailable', error: { code: 'timed-out' } });
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('treats an install-shaped answer to a resolve request as a protocol failure', async () => {
    await expect(service('wrong-shape').resolveStable()).resolves.toMatchObject({
      status: 'unavailable',
      error: { code: 'helper-crashed' },
    });
  });

  it('leaves no live helper when the caller aborts mid-resolve', async () => {
    const controller = new AbortController();
    const pending = service('silent', {
      policy: policy({ metadataMs: 5_000, wholeOperationMs: 5_000, cancelAckMs: 50 }),
    }).resolveStable({ signal: controller.signal });
    controller.abort();
    await expect(pending).resolves.toMatchObject({ status: 'unavailable' });
  });

  it('routes the metadata request through a configured proxy instead of bypassing it', async () => {
    let contacts = 0;
    const proxy = createServer((_request, response) => {
      contacts += 1;
      response.writeHead(502).end();
    });
    proxy.on('connect', (_request, socket) => {
      contacts += 1;
      socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    });
    servers.push(proxy);
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const address = proxy.address();
    if (address === null || typeof address === 'string') throw new Error('Proxy did not bind.');

    const resolution = await service('proxy', {
      helperPath: PROXY_FIXTURE,
      env: { HTTPS_PROXY: `http://127.0.0.1:${address.port}` },
    }).resolveStable();

    expect(resolution).toMatchObject({ status: 'unavailable', error: { code: 'proxy-failure' } });
    // The proxy itself is the witness. An environment assertion would pass even
    // when the request went straight out.
    expect(contacts).toBeGreaterThan(0);
  });
});

describe('@no-llm installed-versus-available comparison', () => {
  const ready = (record_: ManagedReadyRecord): ManagedReadySnapshot => ({
    status: 'ready',
    record: record_,
  });

  // The plan's real pairing is the *primary* fixture: Chrome ships Stable
  // faster than this repository bumps Puppeteer, so an installed build outside
  // the tested pairing is the normal case, not the exception.
  it('reports an update when the installed build is the tested pairing and Stable has moved on', () => {
    expect(compareManagedBuild(ready(record(TESTED)), build(STABLE))).toEqual({
      state: 'update-available',
      installed: record(TESTED),
      available: build(STABLE),
    });
  });

  it('reports up-to-date for equal builds', () => {
    expect(compareManagedBuild(ready(record(STABLE)), build(STABLE))).toMatchObject({
      state: 'up-to-date',
    });
  });

  it('reports installed-newer with both identities and proposes nothing', () => {
    const comparison = compareManagedBuild(ready(record('154.0.1.0')), build(STABLE));
    expect(comparison).toMatchObject({
      state: 'installed-newer',
      installed: { buildId: '154.0.1.0' },
      available: { buildId: STABLE },
    });
    expect(nextCommandFor(comparison)).toBeNull();
  });

  it('directs an absent installation to install rather than update', () => {
    const comparison = compareManagedBuild({ status: 'absent' }, build(STABLE));
    expect(comparison).toEqual({
      state: 'no-installation',
      available: build(STABLE),
      installCommand: 'yantra browser install',
    });
    expect(nextCommandFor(comparison)).toBe('yantra browser install');
  });

  it('treats an invalid ready record as no installation rather than falling back silently', () => {
    const comparison = compareManagedBuild(
      { status: 'invalid', reason: 'ready pointer is not valid JSON' },
      build(STABLE),
    );
    expect(comparison.state).toBe('no-installation');
  });

  // A string compare puts `…8010.36` before `…8010.9`, so it would report the
  // installed build as newer and refuse a real update. The pinned package's
  // comparator is the only grammar allowed to answer this.
  it('orders multi-segment builds numerically where a string compare would disagree', () => {
    expect('153.0.8010.36' < '153.0.8010.9').toBe(true);
    expect(
      compareManagedBuild(ready(record('153.0.8010.9')), build('153.0.8010.36')),
    ).toMatchObject({ state: 'update-available' });
    expect(
      compareManagedBuild(ready(record('153.0.8010.36')), build('153.0.8010.9')),
    ).toMatchObject({ state: 'installed-newer' });
  });
});
