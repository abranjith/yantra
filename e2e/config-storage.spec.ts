import { globSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const documentationPath = resolve(repoRoot, 'docs/features/configuration.md');

function sourceEnvironmentVariables(): Set<string> {
  const variables = new Set<string>();
  const sourceFiles = globSync('{apps,packages}/*/src/**/*.ts', { cwd: repoRoot });
  const dotRead = /\b(?:process\.)?env\.(YANTRA_[A-Z0-9_]+)\b/gu;
  const bracketRead = /\b(?:process\.)?env\[['"](YANTRA_[A-Z0-9_]+)['"]\]/gu;
  for (const filePath of sourceFiles) {
    const source = readFileSync(resolve(repoRoot, filePath), 'utf8');
    for (const pattern of [dotRead, bracketRead]) {
      pattern.lastIndex = 0;
      for (const match of source.matchAll(pattern)) {
        if (match[1]) variables.add(match[1]);
      }
    }
  }
  return variables;
}

function documentedEnvironmentVariables(markdown: string): Set<string> {
  const bounded =
    /<!-- yantra-env-vars:start -->\s*```text\s*([\s\S]*?)\s*```\s*<!-- yantra-env-vars:end -->/u.exec(
      markdown,
    );
  if (!bounded?.[1])
    throw new Error('configuration docs are missing the bounded environment-variable block');
  return new Set(
    bounded[1]
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean),
  );
}

function difference(left: ReadonlySet<string>, right: ReadonlySet<string>): readonly string[] {
  return [...left].filter((entry) => !right.has(entry)).sort();
}

describe('@no-llm configuration/storage documentation boundary', () => {
  it('documents every YANTRA_* source read and no stale variables', () => {
    const source = sourceEnvironmentVariables();
    const documented = documentedEnvironmentVariables(readFileSync(documentationPath, 'utf8'));
    expect(difference(source, documented)).toEqual([]);
    expect(difference(documented, source)).toEqual([]);
  });

  it('detects a deliberately removed documentation row', () => {
    const source = sourceEnvironmentVariables();
    const documented = documentedEnvironmentVariables(readFileSync(documentationPath, 'utf8'));
    const removed = [...source].sort()[0];
    if (!removed) throw new Error('expected at least one YANTRA_* source read');
    documented.delete(removed);
    expect(difference(source, documented)).toEqual([removed]);
  });
});
