import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export function installGitHooks({ cwd = process.cwd() } = {}) {
  const worktreeCheck = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  });

  if (worktreeCheck.status !== 0 || worktreeCheck.stdout.trim() !== 'true') {
    process.stdout.write('Skipping Git hook installation: no Git worktree detected.\n');
    return 0;
  }

  const lefthookCli = resolve(cwd, 'node_modules', 'lefthook', 'bin', 'index.js');
  if (!existsSync(lefthookCli)) {
    process.stdout.write('Skipping Git hook installation: Lefthook is not installed.\n');
    return 0;
  }

  const installation = spawnSync(process.execPath, [lefthookCli, 'install'], {
    cwd,
    stdio: 'inherit',
    windowsHide: true,
  });

  if (installation.error) {
    process.stderr.write(`Failed to start Lefthook: ${installation.error.message}\n`);
    return 1;
  }

  return installation.status ?? 1;
}

const isMainModule =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  process.exitCode = installGitHooks();
}
