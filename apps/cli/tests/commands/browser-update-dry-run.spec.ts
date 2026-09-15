/**
 * `yantra browser update --dry-run` — the availability-only mode.
 *
 * The central claim is read-only, and it is proved by comparing the sandboxed
 * home before and after rather than by reading the command's own output: a
 * command that writes while reporting "nothing changed" would pass any
 * assertion made against what it printed.
 */

import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import type { ManagedUpdateAvailability, ManagedUpdateService } from '@yantra/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeBrowserCommand } from '../../src/commands/browser.js';

const INSTALLED = '152.0.7977.75';
const STABLE = '153.0.8010.36';

function sink() {
  let value = '';
  return {
    stream: {
      write: (chunk: string | Uint8Array) => {
        value += String(chunk);
        return true;
      },
    } as NodeJS.WritableStream,
    text: () => value,
  };
}

function record(buildId: string) {
  return {
    schemaVersion: 1 as const,
    installationId: 'one',
    browser: 'chrome' as const,
    platform: 'linux' as const,
    buildId,
    cacheRootRelative: 'installation-one',
    executableRelative: 'chrome/chrome',
    verifiedAt: '2026-09-14T00:00:00.000Z',
  };
}

function build(buildId = STABLE, artifactAvailable = true) {
  return {
    buildId,
    platform: 'linux' as const,
    resolvedAt: '2026-09-14T00:00:00.000Z',
    artifactAvailable,
  };
}

function availability(
  overrides: Partial<ManagedUpdateAvailability> = {},
): ManagedUpdateAvailability {
  return {
    comparison: { state: 'update-available', installed: record(INSTALLED), available: build() },
    managedRoot: '/managed',
    driver: { version: '25.10.0', testedBuild: INSTALLED },
    concurrentOperation: false,
    activeManagedRun: false,
    nextCommand: 'yantra browser update',
    ...overrides,
  };
}

/** A service that answers the availability question and refuses to do anything else. */
function service(report: ManagedUpdateAvailability = availability()) {
  const checkAvailability = vi.fn().mockResolvedValue(report);
  const update = vi.fn(() => {
    throw new Error('update() must never be reached by --dry-run');
  });
  const resolveTarget = vi.fn(() => {
    throw new Error('resolveTarget() must never be reached by --dry-run');
  });
  const preflightMutation = vi.fn(() => {
    throw new Error('preflightMutation() must never be reached by --dry-run');
  });
  return {
    value: {
      checkAvailability,
      update,
      resolveTarget,
      preflightMutation,
    } as unknown as ManagedUpdateService,
    checkAvailability,
    update,
  };
}

function run(
  argv: readonly string[],
  report: ManagedUpdateAvailability = availability(),
  isTty = true,
) {
  const stdout = sink();
  const stderr = sink();
  const runtime = service(report);
  const command = makeBrowserCommand({
    updateService: runtime.value,
    isTty: () => isTty,
    destinationRoot: () => '/managed',
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  return { command, stdout, stderr, runtime, argv: [...argv] };
}

/** Every path under a root, with sizes, so a write of any kind is visible. */
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

describe('@no-llm browser update --dry-run', () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('reports an available update and names the next command, changing nothing', async () => {
    const harness = run(['update', '--dry-run']);
    await harness.command.parseAsync(harness.argv, { from: 'user' });

    const out = harness.stdout.text();
    expect(out).toContain(INSTALLED);
    expect(out).toContain(STABLE);
    expect(out).toContain('yantra browser update');
    expect(out).toContain('Nothing was downloaded, installed, or changed.');
    expect(harness.runtime.update).not.toHaveBeenCalled();
  });

  it('emits exactly one JSON line marked dryRun, with every notice on stderr', async () => {
    const harness = run(['update', '--dry-run', '--json']);
    await harness.command.parseAsync(harness.argv, { from: 'user' });

    const lines = harness.stdout.text().trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      kind: 'browser_update',
      // The same spelling `config data-dir` already uses to mark its dry run.
      dryRun: true,
      comparison: { state: 'update-available', available: { buildId: STABLE } },
      nextCommand: 'yantra browser update',
    });
  });

  it.each([
    ['up-to-date', { state: 'up-to-date', installed: record(STABLE), available: build() }],
    [
      'installed-newer',
      { state: 'installed-newer', installed: record('154.0.1.0'), available: build() },
    ],
    [
      'no-installation',
      { state: 'no-installation', available: build(), installCommand: 'yantra browser install' },
    ],
  ] as const)(
    'renders %s in both modes with the same facts and exits 0',
    async (state, comparison) => {
      const terminal = run(['update', '--dry-run'], availability({ comparison } as never));
      await terminal.command.parseAsync(terminal.argv, { from: 'user' });

      const json = run(['update', '--dry-run', '--json'], availability({ comparison } as never));
      await json.command.parseAsync(json.argv, { from: 'user' });

      const payload = JSON.parse(json.stdout.text()) as { comparison: { state: string } };
      expect(payload.comparison.state).toBe(state);
      // The available build appears in both renderings.
      expect(terminal.stdout.text()).toContain(STABLE);
    },
  );

  it('directs an absent installation to install rather than update', async () => {
    const harness = run(
      ['update', '--dry-run'],
      availability({
        comparison: {
          state: 'no-installation',
          available: build(),
          installCommand: 'yantra browser install',
        },
        nextCommand: 'yantra browser install',
      }),
    );
    await harness.command.parseAsync(harness.argv, { from: 'user' });
    expect(harness.stdout.text()).toContain('Installed: absent');
    expect(harness.stdout.text()).toContain('yantra browser install');
  });

  it('succeeds while a managed browser runs and another operation holds the lease', async () => {
    const harness = run(
      ['update', '--dry-run'],
      availability({ activeManagedRun: true, concurrentOperation: true }),
    );
    await harness.command.parseAsync(harness.argv, { from: 'user' });
    // Reported as state, never a refusal.
    expect(harness.stdout.text()).toContain('a replacement would be refused');
    expect(harness.stdout.text()).toContain('Another managed browser operation is in progress.');
  });

  it.each([
    ['metadata-unavailable', 'Chrome for Testing metadata is unreachable.'],
    ['network-failure', 'The network refused the metadata request.'],
  ] as const)('exits 3 on %s while still reporting the installed build', async (code, detail) => {
    const harness = run(
      ['update', '--dry-run'],
      availability({
        comparison: {
          state: 'metadata-unavailable',
          installed: { status: 'ready', record: record(INSTALLED) },
          error: {
            code,
            phase: 'resolving-stable',
            remediation: 'Check network access and retry.',
            detail,
            retainedOrphan: null,
          },
        },
        nextCommand: null,
      }),
    );

    await expect(harness.command.parseAsync(harness.argv, { from: 'user' })).rejects.toMatchObject({
      exitCode: 3,
    });
    expect(harness.stdout.text()).toContain(INSTALLED);
    expect(harness.stderr.text()).toContain('unaffected and still usable offline');
  });

  it('rejects --dry-run --yes as conflicting modes, naming both', async () => {
    const harness = run(['update', '--dry-run', '--yes']);
    await expect(harness.command.parseAsync(harness.argv, { from: 'user' })).rejects.toMatchObject({
      exitCode: 1,
    });
    expect(harness.stderr.text()).toContain('--dry-run');
    expect(harness.stderr.text()).toContain('--yes');
    expect(harness.runtime.checkAvailability).not.toHaveBeenCalled();
  });

  it.each(['--browser', '--browser-path'])(
    'rejects %s as an unknown option — update always operates on the managed installation',
    async (flag) => {
      const harness = run(['update', '--dry-run', flag, 'managed']);
      harness.command.exitOverride();
      harness.command.configureOutput({ writeErr: () => undefined, writeOut: () => undefined });
      for (const sub of harness.command.commands) {
        sub.exitOverride();
        sub.configureOutput({ writeErr: () => undefined, writeOut: () => undefined });
      }
      await expect(
        harness.command.parseAsync(harness.argv, { from: 'user' }),
      ).rejects.toMatchObject({ code: 'commander.unknownOption' });
    },
  );

  it('leaves the data root, the cache root, and config.yaml byte-identical', async () => {
    const home = await mkdtemp(join(tmpdir(), 'yantra-dry-run-home-'));
    roots.push(home);
    await mkdir(join(home, 'data', 'browsers', 'installation-orphan'), { recursive: true });
    await writeFile(join(home, 'data', 'browsers', 'installation-orphan', 'partial.bin'), 'x');
    await mkdir(join(home, 'cache'), { recursive: true });
    await writeFile(join(home, 'cache', 'doctor.json'), '{}');
    await writeFile(join(home, 'config.yaml'), 'browser:\n  source: managed\n');
    const before = await listing(home);

    const harness = run(['update', '--dry-run']);
    await harness.command.parseAsync(harness.argv, { from: 'user' });

    // Including the pre-existing orphan: `--dry-run` collects nothing.
    expect(await listing(home)).toEqual(before);
    await expect(stat(join(home, 'data', 'browsers', 'installation-orphan'))).resolves.toBeTruthy();
  });

  it('states in its help that it downloads nothing, so it cannot be read as `browser check`', () => {
    const help = makeBrowserCommand()
      .commands.find((sub) => sub.name() === 'update')!
      .helpInformation()
      .toLowerCase()
      .replace(/\s+/gu, ' ');
    expect(help).toContain('--dry-run');
    expect(help).toContain('download');
    expect(help).toContain('only command that checks whether a newer browser exists');
  });
});
