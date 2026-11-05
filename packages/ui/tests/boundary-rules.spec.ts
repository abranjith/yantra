import { globSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ESLint, type Linter } from 'eslint';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const fixtureDir = 'packages/ui/src/_lint-fixtures';

const eslint = new ESLint({ cwd: repoRoot, ignore: false });

async function lintFixture(name: string): Promise<Linter.LintMessage[]> {
  const results = await eslint.lintFiles([resolve(repoRoot, fixtureDir, name)]);
  return results.flatMap((result) => result.messages);
}

function byRule(messages: readonly Linter.LintMessage[], ruleId: string): Linter.LintMessage[] {
  return messages.filter((message) => message.ruleId === ruleId);
}

/** Production source of the package: everything under src except the fixtures. */
function productionSources(): string[] {
  return globSync('packages/ui/src/**/*.{ts,tsx}', { cwd: repoRoot }).filter(
    (path) => !path.replaceAll('\\', '/').includes('/_lint-fixtures/'),
  );
}

/** Every module specifier in static imports, re-exports and dynamic imports. */
function importSpecifiers(source: string): string[] {
  const pattern = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"]([^'"]+)['"]/gu;
  return [...source.matchAll(pattern)].map((match) => match[1] ?? '');
}

function isForbiddenSpecifier(specifier: string): boolean {
  return /^(?:node:|@yantra\/(?:core|agent|cli)(?:\/|$))/u.test(specifier);
}

describe('@no-llm Drshya lint boundary rules', () => {
  it('rejects Node built-ins with and without the node: prefix', async () => {
    const messages = await lintFixture('imports-node-builtin.ts');

    const builtins = byRule(messages, 'import/no-nodejs-modules');
    expect(builtins.map((message) => message.line)).toEqual([6, 7]);
    expect(builtins[1]?.message).toContain('"path"');

    const restricted = byRule(messages, '@typescript-eslint/no-restricted-imports');
    expect(restricted).toHaveLength(1);
    expect(restricted[0]?.message).toContain('must not import Node built-ins');
    expect(restricted[0]?.message).toContain('plan_ui.md §8 "Dependency direction"');
  }, 60_000);

  it('rejects @yantra/core imports', async () => {
    const restricted = byRule(
      await lintFixture('imports-core.ts'),
      '@typescript-eslint/no-restricted-imports',
    );

    expect(restricted).toHaveLength(1);
    expect(restricted[0]?.message).toContain('must not import Yantra engine packages');
    expect(restricted[0]?.message).toContain('plan_ui.md §8 "Dependency direction"');
  }, 60_000);

  it('rejects a value import from @yantra/protocol', async () => {
    const restricted = byRule(
      await lintFixture('imports-protocol-value.ts'),
      '@typescript-eslint/no-restricted-imports',
    );

    expect(restricted).toHaveLength(1);
    expect(restricted[0]?.message).toContain('with `import type` only');
  }, 60_000);

  it('allows a type-only import from @yantra/protocol', async () => {
    expect(await lintFixture('imports-protocol-type.ts')).toEqual([]);
  }, 60_000);

  it('restricts agent, cli and the provider SDK through the same rule', async () => {
    const results = await eslint.lintText(
      [
        "import { a } from '@yantra/agent';",
        "import { b } from '@yantra/agent/runtime';",
        "import { c } from '@yantra/cli';",
        "import { d } from '@earendil-works/pi-coding-agent';",
        'export const all = [a, b, c, d];',
        '',
      ].join('\n'),
      { filePath: resolve(repoRoot, fixtureDir, 'in-memory-imports.ts') },
    );
    const restricted = byRule(
      results.flatMap((result) => result.messages),
      '@typescript-eslint/no-restricted-imports',
    );

    expect(restricted.map((message) => message.line)).toEqual([1, 2, 3, 4]);
  }, 60_000);

  it('keeps production source free of Node, core and agent imports (source scan)', () => {
    const sources = productionSources();
    expect(sources.length).toBeGreaterThan(0);

    const violations = sources.filter((path) =>
      importSpecifiers(readFileSync(resolve(repoRoot, path), 'utf8')).some(isForbiddenSpecifier),
    );

    expect(violations).toEqual([]);
  });

  it('scans import specifiers, not prose that names a package', () => {
    const source = [
      '/** Never imports @yantra/core or node:fs. */',
      "import { x } from 'node:fs';",
      "export { y } from '@yantra/agent/runtime';",
      "import '@yantra/core';",
      "const z = await import('@yantra/core');",
    ].join('\n');

    expect(importSpecifiers(source)).toEqual([
      'node:fs',
      '@yantra/agent/runtime',
      '@yantra/core',
      '@yantra/core',
    ]);
    expect(importSpecifiers('// mentions @yantra/core only in a comment')).toEqual([]);
  });
});
