import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const escapeCmdArg = (value: string): string => {
  if (!/[\s"&|<>^()]/.test(value)) {
    return value;
  }

  return `"${value.replace(/"/g, '""')}"`;
};

const run = (args: string[]) => {
  if (process.platform === 'win32') {
    const command = ['pnpm', ...args].map(escapeCmdArg).join(' ');
    return spawnSync('cmd.exe', ['/d', '/s', '/c', command], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
  }

  return spawnSync('pnpm', args, {
    cwd: repoRoot,
    encoding: 'utf8',
  });
};

describe('@no-llm formatting and lint smoke', () => {
  it('passes prettier --check for the repository', () => {
    const result = run([
      '--config.verify-deps-before-run=false',
      'exec',
      'prettier',
      '--check',
      '.github/workflows/ci.yml',
      '.prettierrc',
      'lefthook.yml',
      'README.md',
      'CONTRIBUTING.md',
      'docs/protocol-spec.md',
      'e2e/format.spec.ts',
      'e2e/docs.spec.ts',
      'packages/core/tests/boundary-rules.spec.ts',
      'packages/core/src/_lint-fixtures/core-imports-pi-agent-core.ts',
    ]);

    if (result.status !== 0) {
      throw new Error(result.stderr || result.stdout);
    }
    expect(result.status).toBe(0);
  });

  it('passes eslint for the repository', () => {
    const result = run([
      '--config.verify-deps-before-run=false',
      'exec',
      'eslint',
      '.',
      '--max-warnings=0',
    ]);

    if (result.status !== 0) {
      throw new Error(result.stderr || result.stdout);
    }
    expect(result.status).toBe(0);
  });
});
