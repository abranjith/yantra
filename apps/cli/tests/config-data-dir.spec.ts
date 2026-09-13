/**
 * `config data-dir` as a caller of the managed-browser coordination contract.
 *
 * Relocation is not an unrelated command once managed binaries live under the
 * data directory: it has to refuse while a managed run is live, and it has to
 * say what it will do with a tree of re-downloadable binaries before it does it.
 */

import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { managedReadyPath, resetPathCache } from '@yantra/core';
import { CommanderError } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  decideManagedTree,
  makeConfigCommand,
  type DataDirDependencies,
} from '../src/commands/config.js';

const READY_RECORD = {
  schemaVersion: 1,
  installationId: 'abc123',
  browser: 'chrome',
  platform: process.platform === 'win32' ? 'win64' : 'linux',
  buildId: '153.0.8010.36',
  cacheRootRelative: 'installation-abc123',
  executableRelative: 'chrome/linux-153.0.8010.36/chrome-linux64/chrome',
  verifiedAt: '2026-09-12T00:00:00.000Z',
};

describe('@no-llm config data-dir and managed browsers', () => {
  let root: string;
  let savedHome: string | undefined;
  let stdout: string[];
  let stderr: string[];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'yantra-data-dir-'));
    savedHome = process.env.YANTRA_HOME;
    process.env.YANTRA_HOME = root;
    delete process.env.YANTRA_DATA_DIR;
    resetPathCache();
    stdout = [];
    stderr = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      stdout.push(String(chunk));
      return true;
    }) as never);
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      stderr.push(String(chunk));
      return true;
    }) as never);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (savedHome === undefined) delete process.env.YANTRA_HOME;
    else process.env.YANTRA_HOME = savedHome;
    resetPathCache();
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  });

  function run(argv: readonly string[], deps?: DataDirDependencies): Promise<unknown> {
    const command = makeConfigCommand(
      deps ?? { hasActiveManagedUse: () => Promise.resolve(false) },
    );
    return command.parseAsync(['node', 'yantra-config', ...argv]);
  }

  /** Seeds a data directory that already holds a managed installation. */
  async function seedManagedTree(): Promise<{ dataDir: string; managedRoot: string }> {
    const dataDir = join(root, 'data');
    const managedRoot = join(dataDir, 'browsers');
    await mkdir(join(managedRoot, 'installation-abc123', 'chrome'), { recursive: true });
    await writeFile(join(managedRoot, 'installation-abc123', 'chrome', 'bin'), 'binary');
    await writeFile(managedReadyPath(), JSON.stringify(READY_RECORD), 'utf8');
    await mkdir(join(dataDir, 'runs'), { recursive: true });
    await writeFile(join(dataDir, 'runs', 'keep.txt'), 'run artifact');
    return { dataDir, managedRoot };
  }

  it('refuses relocation while a managed browser run is active, before touching the filesystem', async () => {
    const { dataDir, managedRoot } = await seedManagedTree();
    const target = join(root, 'relocated');

    await expect(
      run(['data-dir', target], { hasActiveManagedUse: () => Promise.resolve(true) }),
    ).rejects.toBeInstanceOf(CommanderError);

    expect(stderr.join('')).toMatch(/managed browser run is active/);
    // Nothing moved and nothing was created: no partial relocation exists.
    await expect(stat(managedRoot)).resolves.toBeTruthy();
    await expect(readdir(dataDir)).resolves.toContain('runs');
    await expect(stat(target)).rejects.toThrow();
  });

  it('reports environment exit code 3 for the busy refusal', async () => {
    await seedManagedTree();

    const error = await run(['data-dir', join(root, 'relocated')], {
      hasActiveManagedUse: () => Promise.resolve(true),
    }).catch((e: unknown) => e);

    expect((error as CommanderError).exitCode).toBe(3);
  });

  it('keeps the existing daemon-lock refusal intact', async () => {
    const { FileDaemonLock } = await import('@yantra/core');
    await seedManagedTree();
    vi.spyOn(FileDaemonLock.prototype, 'probe').mockResolvedValue({ pid: 4242 });

    await expect(run(['data-dir', join(root, 'relocated')])).rejects.toBeInstanceOf(CommanderError);

    expect(stderr.join('')).toMatch(/daemon or a run holds the lock/);
  });

  it('moves the managed tree with everything else on the same volume', async () => {
    await seedManagedTree();
    const target = join(root, 'relocated');

    await run(['data-dir', target]);

    // The tree moved, and the executable resolves at the new location by
    // recomputation from the recorded relative identity.
    await expect(
      stat(join(target, 'browsers', 'installation-abc123', 'chrome', 'bin')),
    ).resolves.toBeTruthy();
    await expect(stat(join(target, 'runs', 'keep.txt'))).resolves.toBeTruthy();
    expect(stdout.join('')).toMatch(/Managed browsers: move/);
  });

  it('excludes and removes the managed tree on a cross-volume relocation', async () => {
    const { dataDir, managedRoot } = await seedManagedTree();
    const target = join(root, 'relocated');
    // Force the cross-volume decision without needing a second real volume.
    await run(['data-dir', target], {
      hasActiveManagedUse: () => Promise.resolve(false),
      decideManagedTree: () =>
        Promise.resolve({
          action: 'drop-and-reinstall',
          path: managedRoot,
          note: 'managed browsers are not copied across volumes; run `yantra browser install` afterwards',
        }),
    });

    // Everything else relocated; the managed tree did not, and is gone at the source.
    await expect(stat(join(target, 'runs', 'keep.txt'))).resolves.toBeTruthy();
    await expect(stat(join(target, 'browsers'))).rejects.toThrow();
    await expect(stat(managedRoot)).rejects.toThrow();
    // The data directory's parent survives: nothing recursive reached above it.
    await expect(stat(root)).resolves.toBeTruthy();
    expect(stdout.join('')).toMatch(/Managed browsers: drop-and-reinstall/);
    expect(stdout.join('')).toMatch(/yantra browser install/);
    void dataDir;
  });

  it('reports the managed-tree decision in --dry-run and changes nothing', async () => {
    const { managedRoot } = await seedManagedTree();
    const target = join(root, 'relocated');

    await run(['data-dir', target, '--dry-run']);

    expect(stdout.join('')).toMatch(/Would move/);
    expect(stdout.join('')).toMatch(/Managed browsers: move/);
    await expect(stat(managedRoot)).resolves.toBeTruthy();
    await expect(stat(target)).rejects.toThrow();
  });

  it('carries the same decision in the --json envelope', async () => {
    await seedManagedTree();
    const target = join(root, 'relocated');

    await run(['data-dir', target, '--dry-run', '--json']);

    const payload = JSON.parse(stdout.join('').trim()) as {
      dryRun: boolean;
      managedBrowsers: { action: string; note: string; path: string };
    };
    expect(payload.dryRun).toBe(true);
    expect(payload.managedBrowsers.action).toBe('move');
    expect(payload.managedBrowsers.note).toMatch(/move with the data directory/);
  });

  it('reports the relocated decision in --json after committing', async () => {
    await seedManagedTree();
    const target = join(root, 'relocated');

    await run(['data-dir', target, '--json']);

    const payload = JSON.parse(stdout.join('').trim()) as {
      status: string;
      managedBrowsers: { action: string };
    };
    expect(payload.status).toBe('relocated');
    expect(payload.managedBrowsers.action).toBe('move');
  });

  it('behaves exactly as before when no managed tree is present', async () => {
    const dataDir = join(root, 'data');
    await mkdir(join(dataDir, 'runs'), { recursive: true });
    await writeFile(join(dataDir, 'runs', 'keep.txt'), 'run artifact');
    const target = join(root, 'relocated');

    await run(['data-dir', target]);

    await expect(stat(join(target, 'runs', 'keep.txt'))).resolves.toBeTruthy();
    expect(stdout.join('')).toMatch(/Managed browsers: absent/);
  });

  it('does not consult the managed tree when --no-move is used', async () => {
    const { managedRoot } = await seedManagedTree();
    const target = join(root, 'relocated');

    await run(['data-dir', target, '--no-move']);

    await expect(stat(managedRoot)).resolves.toBeTruthy();
    expect(stdout.join('')).toMatch(/Configured data directory/);
  });

  it('never touches a developer home', () => {
    // The sandbox is the whole point: every path this suite writes is inside
    // the per-test YANTRA_HOME.
    expect(process.env.YANTRA_HOME).toBe(root);
    expect(root.startsWith(tmpdir())).toBe(true);
  });
});

describe('@no-llm decideManagedTree', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'yantra-decide-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  });

  it('reports absent when there is no managed tree', async () => {
    const decision = await decideManagedTree(join(root, 'data'), join(root, 'target'));

    expect(decision.action).toBe('absent');
  });

  it('reports move when source and target share a volume', async () => {
    const source = join(root, 'data');
    await mkdir(join(source, 'browsers'), { recursive: true });

    const decision = await decideManagedTree(source, join(root, 'target'));

    expect(decision.action).toBe('move');
  });

  it('reports drop-and-reinstall when the devices differ', async () => {
    const source = join(root, 'data');
    await mkdir(join(source, 'browsers'), { recursive: true });
    let call = 0;
    const fakeStat = (() => {
      call += 1;
      return Promise.resolve({ isDirectory: () => true, dev: call } as never);
    }) as unknown as typeof stat;

    const decision = await decideManagedTree(source, join(root, 'target'), {
      stat: fakeStat,
      mkdir: (() => Promise.resolve()) as never,
      rename: (() => Promise.resolve()) as never,
      cp: (() => Promise.resolve()) as never,
      rm: (() => Promise.resolve()) as never,
    });

    expect(decision.action).toBe('drop-and-reinstall');
    expect(decision.note).toMatch(/yantra browser install/);
  });
});
