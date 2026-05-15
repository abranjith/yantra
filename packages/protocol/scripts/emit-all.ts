import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { emitJsonSchemas } from '../src/emit/json-schema.js';
import { emitProtocolSpecDoc } from '../src/emit/spec-doc.js';
import { emitToolCatalog } from '../src/emit/tool-catalog.js';

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

const run = async (): Promise<void> => {
  const packageRoot = path.resolve(import.meta.dirname, '..');
  const repositoryRoot = path.resolve(packageRoot, '..', '..');

  await emitJsonSchemas(path.join(packageRoot, 'generated', 'json-schema'));
  await emitToolCatalog(path.join(packageRoot, 'generated'));
  await emitProtocolSpecDoc(repositoryRoot);

  const prettier = runPnpm(['exec', 'prettier', '--write', 'docs/protocol-spec.md'], repositoryRoot);

  if (prettier.status !== 0) {
    throw new Error(prettier.stderr || prettier.stdout || 'Failed to format docs/protocol-spec.md');
  }
};

await run();
