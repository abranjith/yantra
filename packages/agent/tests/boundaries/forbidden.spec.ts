import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { forbiddenAgentSymbols, forbiddenPaths } from './forbidden.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const skippedDirectories = new Set(['node_modules', 'dist', '.turbo', 'coverage', '_lint-fixtures']);

function collectSourceFiles(root: string, files: string[] = []): string[] {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      if (!skippedDirectories.has(entry.name)) collectSourceFiles(fullPath, files);
    } else if (entry.isFile() && /\.(?:ts|md)$/.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

describe('@no-llm FEAT-029 legacy removal boundaries', () => {
  it('keeps a non-empty workspace-relative forbidden-file list', () => {
    expect(forbiddenPaths.length).toBeGreaterThan(0);
    for (const path of forbiddenPaths) {
      expect(path).not.toMatch(/^(?:[A-Za-z]:)?[\\/]/);
      expect(path).not.toContain('..');
    }
  });

  it('keeps all forbidden files absent', () => {
    const existing = forbiddenPaths.filter((path) => existsSync(resolve(repoRoot, path)));
    expect(existing).toEqual([]);
  });

  it('keeps task-shaped client symbols out of agent production sources', () => {
    const files = collectSourceFiles(resolve(repoRoot, 'packages/agent/src'));
    const references = forbiddenAgentSymbols.flatMap((symbol) =>
      files
        .filter((file) => readFileSync(file, 'utf8').includes(symbol))
        .map((file) => `${symbol}: ${relative(repoRoot, file).replace(/\\/g, '/')}`),
    );

    expect(references).toEqual([]);
  });
});
