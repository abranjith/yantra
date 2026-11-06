import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

const packageRoot = resolve(import.meta.dirname, '..', '..');
const commandsSource = join(packageRoot, 'src', 'commands');
const allowedSourceRoots = [commandsSource, join(packageRoot, 'src', 'utils')];
const ALLOWED_PACKAGES = new Set(['zod']);
const NODE_BUILTINS = new Set(builtinModules);

/** Static import/export specifiers, including dynamic `import('…')`. */
function specifiersOf(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
    if (match[1] !== undefined) found.push(match[1]);
  }
  return found;
}

function isNodeBuiltin(specifier: string): boolean {
  return specifier.startsWith('node:') || NODE_BUILTINS.has(specifier.split('/')[0] ?? '');
}

function listTs(directory: string): string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => join(entry.parentPath, entry.name));
}

describe('@no-llm command registry browser-safety boundary', () => {
  it('imports no Node built-in and nothing outside src/commands and src/utils', () => {
    const violations: string[] = [];
    for (const file of listTs(commandsSource)) {
      for (const specifier of specifiersOf(readFileSync(file, 'utf8'))) {
        const where = relative(packageRoot, file).split(sep).join('/');
        if (isNodeBuiltin(specifier)) {
          violations.push(`${where}: Node built-in ${specifier}`);
        } else if (specifier.startsWith('.')) {
          const target = resolve(dirname(file), specifier);
          if (!allowedSourceRoots.some((root) => target.startsWith(root + sep))) {
            violations.push(`${where}: outside the registry boundary ${specifier}`);
          }
        } else if (!ALLOWED_PACKAGES.has(specifier)) {
          violations.push(`${where}: package ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('keeps the built module graph of dist/commands/index.js free of node: specifiers', () => {
    const entry = join(packageRoot, 'dist', 'commands', 'index.js');
    // `turbo run test` depends on this package's build, so dist must exist here;
    // run `npx turbo run build --filter=@yantra/protocol` first when running alone.
    expect({ entry, exists: existsSync(entry) }).toEqual({ entry, exists: true });

    const visited = new Set<string>();
    const external: string[] = [];
    const pending = [entry];
    while (pending.length > 0) {
      const file = pending.pop()!;
      if (visited.has(file)) continue;
      visited.add(file);
      for (const specifier of specifiersOf(readFileSync(file, 'utf8'))) {
        if (specifier.startsWith('.')) pending.push(resolve(dirname(file), specifier));
        else external.push(specifier);
      }
    }

    expect(visited.size).toBeGreaterThan(1);
    expect(external.filter(isNodeBuiltin)).toEqual([]);
    expect([...new Set(external)].sort()).toEqual(['zod']);
  });

  it('detects the specifiers the scan relies on', () => {
    expect(
      specifiersOf(
        "import { a } from 'node:fs';\nexport { b } from './b.js';\nconst c = import('zod');",
      ),
    ).toEqual(['node:fs', './b.js', 'zod']);
    expect(isNodeBuiltin('fs/promises')).toBe(true);
    expect(isNodeBuiltin('zod')).toBe(false);
  });
});
