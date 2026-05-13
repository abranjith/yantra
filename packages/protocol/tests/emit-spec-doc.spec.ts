import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { emitProtocolSpecDoc } from '../src/index.js';

describe('@no-llm protocol spec doc emitter', () => {
  it('includes all major public schemas in generated doc', async () => {
    const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
    await emitProtocolSpecDoc(repoRoot);

    const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
    const prettier = spawnSync(
      pnpmCommand,
      ['exec', 'prettier', '--write', 'docs/protocol-spec.md'],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        shell: process.platform === 'win32',
      },
    );

    expect(prettier.status).toBe(0);

    const content = await readFile(path.join(repoRoot, 'docs', 'protocol-spec.md'), 'utf8');
    expect(content).toContain('## TaskRequest');
    expect(content).toContain('## PlanSchema');
    expect(content).toContain('## Step');
    expect(content).toContain('## TaskEvent');
    expect(content).toContain('## WorkflowFile');
  });
});
