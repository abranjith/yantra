import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const installerPath = resolve(repoRoot, 'scripts/install-git-hooks.mjs');
const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'yantra-git-hooks-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function installFakeLefthook(directory: string): Promise<void> {
  const binDirectory = join(directory, 'node_modules', 'lefthook', 'bin');
  await mkdir(binDirectory, { recursive: true });
  await writeFile(
    join(binDirectory, 'index.js'),
    [
      "const { writeFileSync } = require('node:fs');",
      "writeFileSync(process.env.LEFTHOOK_SENTINEL, process.argv.slice(2).join(' '));",
      "process.exitCode = Number(process.env.LEFTHOOK_EXIT_CODE ?? '0');",
    ].join('\n'),
  );
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('@no-llm Git hook installer', () => {
  it('skips hook installation outside a Git worktree', async () => {
    const directory = await createTemporaryDirectory();

    const result = spawnSync(process.execPath, [installerPath], {
      cwd: directory,
      encoding: 'utf8',
      windowsHide: true,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('no Git worktree detected');
  });

  it('installs hooks inside a Git worktree', async () => {
    const directory = await createTemporaryDirectory();
    const sentinel = join(directory, 'lefthook-ran.txt');
    const gitInit = spawnSync('git', ['init', '--quiet'], {
      cwd: directory,
      encoding: 'utf8',
      windowsHide: true,
    });
    expect(gitInit.status).toBe(0);
    await installFakeLefthook(directory);

    const result = spawnSync(process.execPath, [installerPath], {
      cwd: directory,
      encoding: 'utf8',
      env: { ...process.env, LEFTHOOK_SENTINEL: sentinel },
      windowsHide: true,
    });

    expect(result.status).toBe(0);
    await expect(
      import('node:fs/promises').then(({ readFile }) => readFile(sentinel, 'utf8')),
    ).resolves.toBe('install');
  });

  it('skips hook installation when production dependencies omit Lefthook', async () => {
    const directory = await createTemporaryDirectory();
    const gitInit = spawnSync('git', ['init', '--quiet'], {
      cwd: directory,
      encoding: 'utf8',
      windowsHide: true,
    });
    expect(gitInit.status).toBe(0);

    const result = spawnSync(process.execPath, [installerPath], {
      cwd: directory,
      encoding: 'utf8',
      windowsHide: true,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Lefthook is not installed');
  });

  it('propagates Lefthook failures in a Git worktree', async () => {
    const directory = await createTemporaryDirectory();
    const sentinel = join(directory, 'lefthook-ran.txt');
    const gitInit = spawnSync('git', ['init', '--quiet'], {
      cwd: directory,
      encoding: 'utf8',
      windowsHide: true,
    });
    expect(gitInit.status).toBe(0);
    await installFakeLefthook(directory);

    const result = spawnSync(process.execPath, [installerPath], {
      cwd: directory,
      encoding: 'utf8',
      env: {
        ...process.env,
        LEFTHOOK_EXIT_CODE: '9',
        LEFTHOOK_SENTINEL: sentinel,
      },
      windowsHide: true,
    });

    expect(result.status).toBe(9);
  });
});
