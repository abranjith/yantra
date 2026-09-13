import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  LocalManagedStateReader,
  ManagedReadyRecordSchema,
  assertDefaultBrowserProvider,
  canonicalize,
  isContainedIn,
  managedChildRoot,
  managedExecutablePath,
} from '../../src/browser/managed-state.js';
import { managedBrowsersRoot, managedReadyPath, resetPathCache } from '../../src/browser/paths.js';

const BUILD_ID = '152.0.7977.75';

function readyRecord(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    installationId: 'abc123',
    browser: 'chrome',
    platform: 'linux',
    buildId: BUILD_ID,
    cacheRootRelative: 'installation-abc123',
    executableRelative: `chrome/linux-${BUILD_ID}/chrome-linux64/chrome`,
    verifiedAt: '2026-09-12T00:00:00.000Z',
    ...overrides,
  };
}

describe('@no-llm ManagedReadyRecordSchema', () => {
  it('accepts a well-formed record', () => {
    expect(ManagedReadyRecordSchema.safeParse(readyRecord()).success).toBe(true);
  });

  it.each([
    ['an absolute executable path', { executableRelative: '/opt/chrome/chrome' }],
    ['a Windows absolute executable path', { executableRelative: 'C:\\chrome\\chrome.exe' }],
    ['a traversing executable path', { executableRelative: '../../../etc/passwd' }],
    ['an empty executable path', { executableRelative: '' }],
    ['a nested cache root', { cacheRootRelative: 'installation-a/installation-b' }],
    ['a cache root without the prefix', { cacheRootRelative: 'candidate-1' }],
    ['a traversing cache root', { cacheRootRelative: '../installation-a' }],
    ['a non-decimal build id', { buildId: '152.0.beta' }],
    ['an unsupported platform', { platform: 'solaris' }],
    ['an unsupported browser', { browser: 'firefox' }],
    ['a future schema version', { schemaVersion: 2 }],
    ['an unparseable timestamp', { verifiedAt: 'yesterday' }],
    ['an installation id with a separator', { installationId: 'a/b' }],
  ])('rejects %s', (_label, overrides) => {
    expect(ManagedReadyRecordSchema.safeParse(readyRecord(overrides)).success).toBe(false);
  });
});

describe('@no-llm LocalManagedStateReader', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'yantra-managed-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function reader(liveMutationCandidate?: () => Promise<string | null>) {
    return new LocalManagedStateReader({
      root: () => root,
      readyPath: () => join(root, 'ready.json'),
      ...(liveMutationCandidate ? { liveMutationCandidate } : {}),
    });
  }

  async function writeReady(record: unknown): Promise<void> {
    await writeFile(join(root, 'ready.json'), JSON.stringify(record), 'utf8');
  }

  it('reports absent when no ready pointer exists', async () => {
    await expect(reader().readReady()).resolves.toEqual({ status: 'absent' });
  });

  it('reports invalid for unparseable JSON', async () => {
    await writeFile(join(root, 'ready.json'), '{not json', 'utf8');

    const snapshot = await reader().readReady();

    expect(snapshot.status).toBe('invalid');
    expect(snapshot.status === 'invalid' && snapshot.reason).toMatch(/not valid JSON/);
  });

  it('reports invalid and names the offending field for a malformed record', async () => {
    await writeReady(readyRecord({ executableRelative: '../escape/chrome' }));

    const snapshot = await reader().readReady();

    expect(snapshot.status).toBe('invalid');
    expect(snapshot.status === 'invalid' && snapshot.reason).toMatch(/executableRelative/);
  });

  it('reports ready for a valid record', async () => {
    await writeReady(readyRecord());

    const snapshot = await reader().readReady();

    expect(snapshot.status).toBe('ready');
    expect(snapshot.status === 'ready' && snapshot.record.buildId).toBe(BUILD_ID);
  });

  it('excludes the pointer’s own child from the orphan inventory and counts bytes', async () => {
    await writeReady(readyRecord());
    await mkdir(join(root, 'installation-abc123', 'chrome'), { recursive: true });
    await writeFile(join(root, 'installation-abc123', 'chrome', 'bin'), 'x'.repeat(10));
    await mkdir(join(root, 'installation-old', 'nested'), { recursive: true });
    await writeFile(join(root, 'installation-old', 'nested', 'blob'), 'y'.repeat(64));
    await writeFile(join(root, 'installation-old', 'top'), 'z'.repeat(36));
    await mkdir(join(root, 'coordination'), { recursive: true });

    const inventory = await reader().readInventory();

    expect(inventory.ready.status).toBe('ready');
    expect(inventory.orphans).toEqual([
      { cacheRootRelative: 'installation-old', bytes: 100, hasLiveOwner: false },
    ]);
  });

  it('marks the orphan a live mutation lease names as owned', async () => {
    await writeReady(readyRecord());
    await mkdir(join(root, 'installation-candidate'), { recursive: true });
    await mkdir(join(root, 'installation-dead'), { recursive: true });

    const inventory = await reader(() => Promise.resolve('installation-candidate')).readInventory();

    expect(inventory.orphans).toEqual([
      { cacheRootRelative: 'installation-candidate', bytes: 0, hasLiveOwner: true },
      { cacheRootRelative: 'installation-dead', bytes: 0, hasLiveOwner: false },
    ]);
  });

  it('treats every child as an orphan when the pointer is absent, and deletes nothing', async () => {
    await mkdir(join(root, 'installation-one'), { recursive: true });
    await mkdir(join(root, 'installation-two'), { recursive: true });

    const inventory = await reader().readInventory();

    expect(inventory.ready).toEqual({ status: 'absent' });
    expect(inventory.orphans.map((o) => o.cacheRootRelative)).toEqual([
      'installation-one',
      'installation-two',
    ]);
    // The read is non-destructive: both children survive it.
    const after = await reader().readInventory();
    expect(after.orphans).toHaveLength(2);
  });

  it('returns an empty inventory when the managed root does not exist', async () => {
    const absent = new LocalManagedStateReader({
      root: () => join(root, 'missing'),
      readyPath: () => join(root, 'missing', 'ready.json'),
    });

    await expect(absent.readInventory()).resolves.toEqual({
      ready: { status: 'absent' },
      orphans: [],
    });
  });
});

describe('@no-llm managed executable recomputation', () => {
  it('agrees with the recorded relative identity', () => {
    const record = ManagedReadyRecordSchema.parse(readyRecord());

    const { path, agrees } = managedExecutablePath(record, '/data/browsers');

    expect(agrees).toBe(true);
    expect(resolve(path)).toBe(
      resolve('/data/browsers/installation-abc123', record.executableRelative),
    );
  });

  it('reports disagreement when the record names a different executable', () => {
    const record = ManagedReadyRecordSchema.parse(
      readyRecord({ executableRelative: 'chrome/linux-1.2.3/chrome-linux64/chrome' }),
    );

    expect(managedExecutablePath(record, '/data/browsers').agrees).toBe(false);
  });

  it('recomputes to a different absolute path after the data root is relocated', () => {
    const record = ManagedReadyRecordSchema.parse(readyRecord());

    const before = managedExecutablePath(record, '/old/browsers');
    const after = managedExecutablePath(record, '/new/location/browsers');

    expect(before.agrees && after.agrees).toBe(true);
    expect(before.path).not.toBe(after.path);
    expect(resolve(after.path)).toBe(
      resolve('/new/location/browsers/installation-abc123', record.executableRelative),
    );
  });

  it('places the child root under the managed root', () => {
    const record = ManagedReadyRecordSchema.parse(readyRecord());

    expect(managedChildRoot(record, '/data/browsers')).toBe(
      join('/data/browsers', 'installation-abc123'),
    );
  });
});

describe('@no-llm relocation of a real managed tree', () => {
  let home: string;
  const savedHome = process.env.YANTRA_HOME;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'yantra-home-'));
    process.env.YANTRA_HOME = home;
    resetPathCache();
  });

  afterEach(async () => {
    if (savedHome === undefined) delete process.env.YANTRA_HOME;
    else process.env.YANTRA_HOME = savedHome;
    resetPathCache();
    await rm(home, { recursive: true, force: true });
  });

  it('resolves a real executable after the whole tree moves', async () => {
    const record = ManagedReadyRecordSchema.parse(
      readyRecord({
        platform: process.platform === 'win32' ? 'win64' : 'linux',
        executableRelative:
          process.platform === 'win32'
            ? `chrome/win64-${BUILD_ID}/chrome-win64/chrome.exe`
            : `chrome/linux-${BUILD_ID}/chrome-linux64/chrome`,
      }),
    );
    const first = managedExecutablePath(record, managedBrowsersRoot());
    expect(first.agrees).toBe(true);
    await mkdir(join(first.path, '..'), { recursive: true });
    await writeFile(first.path, 'binary');
    await writeFile(managedReadyPath(), JSON.stringify(record), 'utf8');

    // Relocate: a new home with the same relative tree must still resolve.
    const relocated = await mkdtemp(join(tmpdir(), 'yantra-home2-'));
    try {
      process.env.YANTRA_HOME = relocated;
      resetPathCache();
      const second = managedExecutablePath(record, managedBrowsersRoot());
      expect(second.path).not.toBe(first.path);
      await mkdir(join(second.path, '..'), { recursive: true });
      await writeFile(second.path, 'binary');
      await expect(canonicalize(second.path)).resolves.not.toBeNull();
    } finally {
      await rm(relocated, { recursive: true, force: true });
    }
  });
});

describe('@no-llm assertDefaultBrowserProvider', () => {
  it('accepts options with no provider', () => {
    expect(() => assertDefaultBrowserProvider({})).not.toThrow();
    expect(() => assertDefaultBrowserProvider({ provider: undefined })).not.toThrow();
  });

  it('refuses a configured custom provider', () => {
    expect(() => assertDefaultBrowserProvider({ provider: { getName: () => 'Custom' } })).toThrow(
      /default official provider/,
    );
  });
});

describe('@no-llm canonical containment', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'yantra-contain-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('accepts a path inside the root', async () => {
    await mkdir(join(root, 'a', 'b'), { recursive: true });
    await expect(isContainedIn(join(root, 'a', 'b'), root)).resolves.toBe(true);
  });

  it('rejects a sibling path that merely shares a prefix', async () => {
    await expect(isContainedIn(`${root}-sibling`, root)).resolves.toBe(false);
  });

  it('canonicalizes a path whose leaf does not exist yet', async () => {
    const canonical = await canonicalize(join(root, 'not', 'created', 'yet'));

    expect(canonical).not.toBeNull();
    expect(canonical!.endsWith(join('not', 'created', 'yet'))).toBe(true);
  });
});
