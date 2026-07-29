import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
    // Emits into an isolated temp dir rather than the repo's tracked
    // docs/protocol-spec.md: writing the real file here raced with
    // format.spec.ts's repo-wide `prettier --check`, which could observe the
    // doc mid-regeneration (post-emit, pre-format) and fail spuriously.
    const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
    const outDir = await mkdtemp(path.join(tmpdir(), 'yantra-protocol-spec-doc-'));
    try {
      await emitProtocolSpecDoc(outDir);

      const docPath = path.join(outDir, 'docs', 'protocol-spec.md');
      const prettier = runPnpm(
        ['exec', 'prettier', '--config', path.join(repoRoot, '.prettierrc'), '--write', docPath],
        repoRoot,
      );

      expect(prettier.status).toBe(0);

      const content = await readFile(docPath, 'utf8');
      expect(content).toContain('## TaskRequest');
      expect(content).toContain('## PlanSchema');
      expect(content).toContain('## Step');
      expect(content).toContain('## TaskEvent');
      expect(content).toContain('## WorkflowFile');
      expect(content).toContain('## AgentManifestSection');
      expect(content).toContain('## ToolAuditEntry');
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });
});
