import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { emitProtocolSpecDoc } from '../src/index.js';

const escapeCmdArg = (value: string): string => {
  if (!/[\s"&|<>^()]/.test(value)) {
    return value;
  }

  return `"${value.replace(/"/g, '""')}"`;
};

const runPnpm = (args: string[], cwd: string) => {
  if (process.platform === 'win32') {
    const command = ['pnpm', ...args].map(escapeCmdArg).join(' ');
    return spawnSync('cmd.exe', ['/d', '/s', '/c', command], {
      cwd,
      encoding: 'utf8',
    });
  }

  return spawnSync('pnpm', args, {
    cwd,
    encoding: 'utf8',
  });
};

describe('@no-llm protocol spec doc emitter', () => {
  it('includes all major public schemas in generated doc', async () => {
    const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
    await emitProtocolSpecDoc(repoRoot);

    const prettier = runPnpm(['exec', 'prettier', '--write', 'docs/protocol-spec.md'], repoRoot);

    expect(prettier.status).toBe(0);

    const content = await readFile(path.join(repoRoot, 'docs', 'protocol-spec.md'), 'utf8');
    expect(content).toContain('## TaskRequest');
    expect(content).toContain('## PlanSchema');
    expect(content).toContain('## Step');
    expect(content).toContain('## TaskEvent');
    expect(content).toContain('## WorkflowFile');
  });
});
