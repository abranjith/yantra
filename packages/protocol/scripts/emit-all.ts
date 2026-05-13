import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { emitJsonSchemas } from '../src/emit/json-schema.js';
import { emitProtocolSpecDoc } from '../src/emit/spec-doc.js';
import { emitToolCatalog } from '../src/emit/tool-catalog.js';

const run = async (): Promise<void> => {
  const packageRoot = path.resolve(import.meta.dirname, '..');
  const repositoryRoot = path.resolve(packageRoot, '..', '..');

  await emitJsonSchemas(path.join(packageRoot, 'generated', 'json-schema'));
  await emitToolCatalog(path.join(packageRoot, 'generated'));
  await emitProtocolSpecDoc(repositoryRoot);

  const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const prettier = spawnSync(
    pnpmCommand,
    ['exec', 'prettier', '--write', 'docs/protocol-spec.md'],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      shell: process.platform === 'win32',
    },
  );

  if (prettier.status !== 0) {
    throw new Error(prettier.stderr || prettier.stdout || 'Failed to format docs/protocol-spec.md');
  }
};

await run();
