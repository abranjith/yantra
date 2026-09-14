import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ManagedInventory, ManagedStateReader } from '../../src/browser/installation-types.js';
import { OrphanCollector } from '../../src/browser/orphan-collection.js';

describe('@no-llm managed orphan collection', () => {
  let root: string;
  let inventory: ManagedInventory;
  let state: ManagedStateReader;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'yantra-orphans-'));
    inventory = { ready: { status: 'absent' }, orphans: [] };
    state = {
      readReady: () => Promise.resolve(inventory.ready),
      readInventory: () => Promise.resolve(inventory),
    };
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('deletes exactly unowned installation children and reports reclaimed bytes', async () => {
    await mkdir(join(root, 'installation-old'));
    await writeFile(join(root, 'installation-old', 'archive.bin'), 'payload');
    inventory = {
      ready: { status: 'absent' },
      orphans: [{ cacheRootRelative: 'installation-old', bytes: 7, hasLiveOwner: false }],
    };
    await expect(new OrphanCollector({ state, root: () => root }).collect()).resolves.toEqual({
      attempted: 1,
      deleted: 1,
      bytesReclaimed: 7,
      skippedLiveOwner: 0,
      failed: [],
    });
    await expect(stat(join(root, 'installation-old'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('skips a child with a live mutation owner', async () => {
    await mkdir(join(root, 'installation-live'));
    inventory = {
      ready: { status: 'absent' },
      orphans: [{ cacheRootRelative: 'installation-live', bytes: 0, hasLiveOwner: true }],
    };
    await expect(new OrphanCollector({ state, root: () => root }).collect()).resolves.toMatchObject(
      { attempted: 0, skippedLiveOwner: 1 },
    );
    await expect(stat(join(root, 'installation-live'))).resolves.toBeDefined();
  });

  it('refuses the ready child even when a malicious inventory labels it orphaned', async () => {
    await mkdir(join(root, 'installation-ready'));
    await writeFile(join(root, 'installation-ready', 'keep'), 'yes');
    inventory = {
      ready: {
        status: 'ready',
        record: {
          schemaVersion: 1,
          installationId: 'ready',
          browser: 'chrome',
          platform: 'linux',
          buildId: '153.0.8010.36',
          cacheRootRelative: 'installation-ready',
          executableRelative: 'chrome',
          verifiedAt: '2026-09-14T00:00:00.000Z',
        },
      },
      orphans: [{ cacheRootRelative: 'installation-ready', bytes: 3, hasLiveOwner: false }],
    };
    const report = await new OrphanCollector({ state, root: () => root }).collect();
    expect(report.failed[0]?.reason).toContain('ready');
    await expect(readFile(join(root, 'installation-ready', 'keep'), 'utf8')).resolves.toBe('yes');
  });

  it('refuses traversal and canonical escapes without invoking recursive removal', async () => {
    const remove = vi.fn();
    inventory = {
      ready: { status: 'absent' },
      orphans: [
        { cacheRootRelative: '../outside', bytes: 9, hasLiveOwner: false },
        { cacheRootRelative: 'installation-escape', bytes: 9, hasLiveOwner: false },
      ],
    };
    await mkdir(join(root, 'installation-escape'));
    const canonicalize = vi.fn(async (path: string) =>
      path.endsWith('installation-escape') ? join(root, '..', 'outside') : root,
    );
    const report = await new OrphanCollector({
      state,
      root: () => root,
      remove: remove as never,
      canonicalize,
    }).collect();
    expect(report.failed).toHaveLength(2);
    expect(remove).not.toHaveBeenCalled();
  });

  it('reports a failed deletion and retries it on the next collection', async () => {
    await mkdir(join(root, 'installation-old'));
    inventory = {
      ready: { status: 'absent' },
      orphans: [{ cacheRootRelative: 'installation-old', bytes: 0, hasLiveOwner: false }],
    };
    const remove = vi
      .fn()
      .mockRejectedValueOnce(new Error('file busy'))
      .mockImplementation((path: string) => rm(path, { recursive: true }));
    const collector = new OrphanCollector({ state, root: () => root, remove: remove as never });
    expect((await collector.collect()).failed[0]?.reason).toContain('busy');
    expect((await collector.collect()).deleted).toBe(1);
  });
});
