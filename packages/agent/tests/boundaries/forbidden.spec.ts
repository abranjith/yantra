import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { resolveCommandTaskProfile } from '../../src/runtime/profiles.js';

import { forbiddenAgentSymbols, forbiddenPaths } from './forbidden.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const skippedDirectories = new Set([
  'node_modules',
  'dist',
  '.turbo',
  'coverage',
  '_lint-fixtures',
]);

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

describe('@no-llm FEAT-052 research browsing has no environment switch', () => {
  // The retired switch. This file is the one place allowed to name it.
  const retired = 'YANTRA_AGENT_RESEARCH_BROWSE';
  const self = fileURLToPath(import.meta.url);

  it('names the retired switch nowhere in source, tests, or docs', () => {
    const files = ['packages', 'apps', 'e2e', 'docs'].flatMap((root) =>
      collectSourceFiles(resolve(repoRoot, root)),
    );
    const references = files
      .filter((file) => resolve(file) !== resolve(self))
      .filter((file) => readFileSync(file, 'utf8').includes(retired))
      .map((file) => relative(repoRoot, file).replace(/\\/g, '/'));

    expect(references).toEqual([]);
  });

  it('cannot change a research catalog through the environment', () => {
    const previous = process.env[retired];
    try {
      for (const value of ['0', '1', 'true', 'false']) {
        process.env[retired] = value;
        expect(resolveCommandTaskProfile('research', { browse: true }).toolNames).toContain(
          'browser_navigate',
        );
        expect(resolveCommandTaskProfile('research', { browse: false }).toolNames).not.toContain(
          'browser_navigate',
        );
      }
    } finally {
      if (previous === undefined) delete process.env[retired];
      else process.env[retired] = previous;
    }
  });
});
