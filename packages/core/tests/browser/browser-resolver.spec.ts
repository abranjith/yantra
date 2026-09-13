import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  LocalBrowserResolver,
  toChromeInstall,
  validateSelection,
} from '../../src/browser/browser-resolver.js';
import type {
  BrowserResolution,
  BrowserSelection,
  ManagedReadySnapshot,
  ManagedStateReader,
  ResolvedBrowserInstallation,
} from '../../src/browser/installation-types.js';
import {
  ManagedReadyRecordSchema,
  managedExecutablePath,
} from '../../src/browser/managed-state.js';
import type { ChromeInstall } from '../../src/browser/types.js';

const BUILD_ID = '152.0.7977.75';
const MANAGED_PLATFORM = process.platform === 'win32' ? 'win64' : 'linux';

/**
 * Path of the fake externally discovered binary. Discovery is a boundary fake,
 * but the file it names is real: resolution re-stats the executable for its
 * fingerprint, so a nonexistent fixture path would make every external case
 * fail for the wrong reason.
 */
let discoveredPath = '';

function readyRecord(overrides: Record<string, unknown> = {}) {
  return ManagedReadyRecordSchema.parse({
    schemaVersion: 1,
    installationId: 'abc123',
    browser: 'chrome',
    platform: MANAGED_PLATFORM,
    buildId: BUILD_ID,
    cacheRootRelative: 'installation-abc123',
    executableRelative:
      process.platform === 'win32'
        ? `chrome/win64-${BUILD_ID}/chrome-win64/chrome.exe`
        : `chrome/linux-${BUILD_ID}/chrome-linux64/chrome`,
    verifiedAt: '2026-09-12T00:00:00.000Z',
    ...overrides,
  });
}

function externalChrome(overrides: Partial<ChromeInstall> = {}): ChromeInstall {
  return {
    path: discoveredPath,
    version: '153.0.8010.36',
    majorVersion: 153,
    channel: 'stable',
    source: 'system',
    ...overrides,
  };
}

function stateReader(snapshot: ManagedReadySnapshot): ManagedStateReader {
  return {
    readReady: vi.fn().mockResolvedValue(snapshot),
    readInventory: vi.fn().mockResolvedValue({ ready: snapshot, orphans: [] }),
  };
}

function expectResolved(resolution: BrowserResolution): ResolvedBrowserInstallation {
  if (resolution.status !== 'resolved') {
    throw new Error(`expected a resolved installation, got ${resolution.error.code}`);
  }
  return resolution.installation;
}

function expectUnavailable(resolution: BrowserResolution) {
  if (resolution.status !== 'unavailable') {
    throw new Error('expected the resolution to be unavailable');
  }
  return resolution.error;
}

describe('@no-llm validateSelection', () => {
  it('accepts every source with no path', () => {
    for (const source of ['auto', 'managed', 'system'] as const) {
      expect(validateSelection({ source, executablePath: null })).toBeNull();
    }
  });

  it('accepts an absolute path with system', () => {
    const path = process.platform === 'win32' ? 'C:\\chrome\\chrome.exe' : '/opt/chrome/chrome';
    expect(validateSelection({ source: 'system', executablePath: path })).toBeNull();
  });

  it.each(['auto', 'managed'] as const)('rejects an explicit path with %s', (source) => {
    expect(validateSelection({ source, executablePath: '/opt/chrome/chrome' })).toMatch(
      /legal only with source "system"/,
    );
  });

  it('rejects a relative path', () => {
    expect(validateSelection({ source: 'system', executablePath: 'chrome' })).toMatch(
      /must be absolute/,
    );
  });
});

describe('@no-llm LocalBrowserResolver — precedence', () => {
  let root: string;
  let discover: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'yantra-resolver-'));
    discoveredPath = join(root, 'discovered-chrome');
    await writeFile(discoveredPath, 'binary');
    discover = vi.fn(() => externalChrome());
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function makeResolver(opts: {
    configured?: BrowserSelection | undefined;
    ready?: ManagedReadySnapshot;
  }) {
    return new LocalBrowserResolver({
      selectionReader: { read: () => Promise.resolve(opts.configured) },
      managedState: stateReader(opts.ready ?? { status: 'absent' }),
      discover: discover as unknown as (o?: { override?: string }) => ChromeInstall | null,
      managedRoot: () => root,
      platform: 'linux',
      architecture: 'x64',
    });
  }

  it('uses the default auto selection when nothing is configured', async () => {
    const installation = expectResolved(await makeResolver({}).resolve());

    expect(installation.selectionOrigin).toBe('default');
    expect(installation.requestedSelection).toEqual({ source: 'auto', executablePath: null });
    expect(installation.selectionReason).toBe('system-discovery');
  });

  it('uses the configured selection when the invocation supplies none', async () => {
    const installation = expectResolved(
      await makeResolver({ configured: { source: 'system', executablePath: null } }).resolve(),
    );

    expect(installation.selectionOrigin).toBe('config');
  });

  it('lets an invocation selection win over the configured one', async () => {
    const resolver = makeResolver({
      configured: { source: 'managed', executablePath: null },
      ready: { status: 'absent' },
    });

    const installation = expectResolved(
      await resolver.resolve({ source: 'system', executablePath: null }),
    );

    expect(installation.selectionOrigin).toBe('invocation');
    expect(installation.ownership).toBe('external');
  });

  it('clears a configured custom path when the invocation asks for plain system', async () => {
    const resolver = makeResolver({
      configured: { source: 'system', executablePath: '/custom/never-used/chrome' },
    });

    const installation = expectResolved(
      await resolver.resolve({ source: 'system', executablePath: null }),
    );

    // Precedence replaces the whole selection: the configured path is gone,
    // not merged back in field-by-field.
    expect(installation.selectionReason).toBe('system-discovery');
    expect(discover).toHaveBeenCalledWith();
    expect(discover).not.toHaveBeenCalledWith({ override: expect.anything() });
  });

  it('rejects a malformed selection before touching the filesystem', async () => {
    const error = expectUnavailable(
      await makeResolver({}).resolve({ source: 'managed', executablePath: '/opt/chrome' }),
    );

    expect(error.code).toBe('invalid-selection');
    expect(discover).not.toHaveBeenCalled();
  });
});

describe('@no-llm LocalBrowserResolver — managed and external', () => {
  let root: string;
  let executable: string;
  let discover: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'yantra-resolver-'));
    discoveredPath = join(root, 'discovered-chrome');
    await writeFile(discoveredPath, 'binary');
    executable = managedExecutablePath(readyRecord(), root).path;
    await mkdir(join(executable, '..'), { recursive: true });
    await writeFile(executable, 'binary');
    discover = vi.fn((opts?: { override?: string }) =>
      opts?.override
        ? externalChrome({ path: opts.override, version: '153.0.8010.36', majorVersion: 153 })
        : externalChrome(),
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function makeResolver(ready: ManagedReadySnapshot, overrides = {}) {
    return new LocalBrowserResolver({
      managedState: stateReader(ready),
      discover: discover as unknown as (o?: { override?: string }) => ChromeInstall | null,
      managedRoot: () => root,
      platform: 'linux',
      architecture: 'x64',
      ...overrides,
    });
  }

  it('prefers a ready managed installation under auto', async () => {
    const record = readyRecord();

    const installation = expectResolved(await makeResolver({ status: 'ready', record }).resolve());

    expect(installation.ownership).toBe('managed');
    expect(installation.selectionReason).toBe('managed-preferred');
    expect(installation.managedIdentity).toEqual(record);
    expect(
      installation.canonicalPath.endsWith('chrome.exe') ||
        installation.canonicalPath.endsWith('chrome'),
    ).toBe(true);
  });

  it('falls back to external discovery when no managed installation exists', async () => {
    const installation = expectResolved(await makeResolver({ status: 'absent' }).resolve());

    expect(installation.ownership).toBe('external');
    expect(installation.selectionReason).toBe('system-discovery');
    expect(installation.managedIdentity).toBeNull();
  });

  it('fails closed under auto when the managed record is corrupt', async () => {
    const error = expectUnavailable(
      await makeResolver({ status: 'invalid', reason: 'buildId is malformed' }).resolve(),
    );

    expect(error.code).toBe('managed-state-invalid');
    expect(error.remediation).toMatch(/yantra browser install/);
    // Fail-closed means it does not quietly reach for external Chrome instead.
    expect(discover).not.toHaveBeenCalled();
  });

  it('reports an explicit managed selection with nothing installed as missing', async () => {
    const error = expectUnavailable(
      await makeResolver({ status: 'absent' }).resolve({
        source: 'managed',
        executablePath: null,
      }),
    );

    expect(error.code).toBe('missing');
    expect(error.remediation).toMatch(/yantra browser install/);
  });

  it('reports managed-state-invalid when the recorded executable is missing on disk', async () => {
    await rm(executable);

    const error = expectUnavailable(
      await makeResolver({ status: 'ready', record: readyRecord() }).resolve({
        source: 'managed',
        executablePath: null,
      }),
    );

    expect(error.code).toBe('managed-state-invalid');
  });

  it('reports managed-state-invalid when the record disagrees with the layout', async () => {
    const record = readyRecord({
      executableRelative: 'chrome/linux-1.0.0.0/chrome-linux64/chrome',
    });

    const error = expectUnavailable(
      await makeResolver({ status: 'ready', record }).resolve({
        source: 'managed',
        executablePath: null,
      }),
    );

    expect(error.code).toBe('managed-state-invalid');
  });

  it('never uses the managed installation for an explicit system selection', async () => {
    const installation = expectResolved(
      await makeResolver({ status: 'ready', record: readyRecord() }).resolve({
        source: 'system',
        executablePath: null,
      }),
    );

    expect(installation.ownership).toBe('external');
    expect(installation.selectionReason).toBe('system-discovery');
  });

  it('reports missing when no browser is discovered at all', async () => {
    discover.mockReturnValue(null);

    const error = expectUnavailable(await makeResolver({ status: 'absent' }).resolve());

    expect(error.code).toBe('missing');
    expect(error.remediation).toMatch(/Chrome or Chromium/);
  });

  it('refuses managed selection on a host with no published build', async () => {
    const error = expectUnavailable(
      await makeResolver(
        { status: 'ready', record: readyRecord() },
        { supportedHost: () => false, platform: 'freebsd', architecture: 'ppc64' },
      ).resolve({ source: 'managed', executablePath: null }),
    );

    expect(error.code).toBe('unsupported-platform');
  });

  it.each([
    ['an older external build', '118.0.5993.70', 118],
    ['a newer external build', '999.0.1.0', 999],
  ])('accepts %s with no minimum-major rejection', async (_label, version, major) => {
    discover.mockReturnValue(externalChrome({ version, majorVersion: major }));

    const installation = expectResolved(await makeResolver({ status: 'absent' }).resolve());

    expect(installation.majorVersion).toBe(major);
  });

  it('projects the resolved installation onto the legacy ChromeInstall shape', async () => {
    const installation = expectResolved(
      await makeResolver({ status: 'ready', record: readyRecord() }).resolve(),
    );

    expect(toChromeInstall(installation)).toMatchObject({
      path: installation.canonicalPath,
      version: installation.version,
      source: 'managed',
    });
  });
});

describe('@no-llm LocalBrowserResolver — custom paths', () => {
  let root: string;
  let outside: string;
  let managedExecutable: string;
  let discover: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const base = await mkdtemp(join(tmpdir(), 'yantra-custom-'));
    root = join(base, 'browsers');
    outside = join(base, 'outside');
    await mkdir(outside, { recursive: true });
    managedExecutable = managedExecutablePath(readyRecord(), root).path;
    await mkdir(join(managedExecutable, '..'), { recursive: true });
    await writeFile(managedExecutable, 'binary');
    discoveredPath = join(outside, 'discovered-chrome');
    await writeFile(discoveredPath, 'binary');
    discover = vi.fn((opts?: { override?: string }) =>
      externalChrome({ path: opts?.override ?? discoveredPath }),
    );
  });

  afterEach(async () => {
    await rm(join(root, '..'), { recursive: true, force: true });
  });

  function makeResolver(ready: ManagedReadySnapshot) {
    return new LocalBrowserResolver({
      managedState: stateReader(ready),
      discover: discover as unknown as (o?: { override?: string }) => ChromeInstall | null,
      managedRoot: () => root,
      platform: process.platform,
      architecture: process.arch,
    });
  }

  it('classifies a custom path into the ready tree as managed-owned', async () => {
    const record = readyRecord();

    const installation = expectResolved(
      await makeResolver({ status: 'ready', record }).resolve({
        source: 'system',
        executablePath: managedExecutable,
      }),
    );

    // Ownership is canonical, not a restatement of how the caller spelled it.
    expect(installation.ownership).toBe('managed');
    expect(installation.selectionReason).toBe('custom-path');
    expect(installation.managedIdentity).toEqual(record);
  });

  it('rejects a custom path into an orphan tree', async () => {
    const orphanExecutable = join(root, 'installation-orphan', 'chrome-linux64', 'chrome');
    await mkdir(join(orphanExecutable, '..'), { recursive: true });
    await writeFile(orphanExecutable, 'binary');

    const error = expectUnavailable(
      await makeResolver({ status: 'ready', record: readyRecord() }).resolve({
        source: 'system',
        executablePath: orphanExecutable,
      }),
    );

    expect(error.code).toBe('invalid-selection');
    expect(error.message).toMatch(/not the ready installation/);
  });

  it('rejects a managed-root path when no managed installation is ready', async () => {
    const error = expectUnavailable(
      await makeResolver({ status: 'absent' }).resolve({
        source: 'system',
        executablePath: managedExecutable,
      }),
    );

    expect(error.code).toBe('invalid-selection');
  });

  it('accepts an ordinary external custom path', async () => {
    const external = join(outside, 'chrome');
    await writeFile(external, 'binary');

    const installation = expectResolved(
      await makeResolver({ status: 'absent' }).resolve({
        source: 'system',
        executablePath: external,
      }),
    );

    expect(installation.ownership).toBe('external');
    expect(installation.selectionReason).toBe('custom-path');
  });

  it('reports missing for an explicit path that does not exist', async () => {
    const error = expectUnavailable(
      await makeResolver({ status: 'absent' }).resolve({
        source: 'system',
        executablePath: join(outside, 'not-there'),
      }),
    );

    expect(error.code).toBe('missing');
  });

  it('reports invalid-executable when the version cannot be read', async () => {
    const external = join(outside, 'not-chrome');
    await writeFile(external, 'binary');
    discover.mockReturnValue(null);

    const error = expectUnavailable(
      await makeResolver({ status: 'absent' }).resolve({
        source: 'system',
        executablePath: external,
      }),
    );

    expect(error.code).toBe('invalid-executable');
  });

  it('rejects a symlink inside the managed root that escapes it', async () => {
    const target = join(outside, 'smuggled');
    await writeFile(target, 'binary');
    const link = join(root, 'installation-abc123', 'smuggled-link');
    try {
      await symlink(target, link);
    } catch {
      return; // Unprivileged Windows hosts cannot create symlinks; nothing to assert.
    }

    const error = expectUnavailable(
      await makeResolver({ status: 'ready', record: readyRecord() }).resolve({
        source: 'system',
        executablePath: link,
      }),
    );

    expect(error.code).toBe('invalid-selection');
    expect(error.message).toMatch(/symlink or junction/);
  });

  it('classifies a symlink from outside that lands in the ready tree as managed', async () => {
    const link = join(outside, 'managed-link');
    try {
      await symlink(managedExecutable, link);
    } catch {
      return;
    }

    const error = expectUnavailable(
      await makeResolver({ status: 'ready', record: readyRecord() }).resolve({
        source: 'system',
        executablePath: link,
      }),
    );

    // Lexically external, canonically managed — the mismatch is refused rather
    // than silently granting managed ownership through an alias.
    expect(error.code).toBe('invalid-selection');
  });
});

describe('@no-llm LocalBrowserResolver — read-only guarantees', () => {
  it('never launches a browser or opens a network connection while resolving', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yantra-readonly-'));
    discoveredPath = join(root, 'discovered-chrome');
    await writeFile(discoveredPath, 'binary');
    const discover = vi.fn(() => externalChrome());
    const resolver = new LocalBrowserResolver({
      managedState: stateReader({ status: 'absent' }),
      discover: discover as unknown as (o?: { override?: string }) => ChromeInstall | null,
      managedRoot: () => root,
      platform: 'linux',
      architecture: 'x64',
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    try {
      await resolver.resolve();
      await resolver.resolve({ source: 'system', executablePath: null });

      expect(fetchSpy).not.toHaveBeenCalled();
      // Discovery is the only external boundary, and it reads version metadata.
      expect(discover).toHaveBeenCalledTimes(2);
    } finally {
      fetchSpy.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });
});
