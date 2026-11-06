import { globSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ESLint, type Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const fixtureDir = 'packages/ui/src/_lint-fixtures';

const eslint = new ESLint({ cwd: repoRoot, ignore: false });

/**
 * For in-memory snippets at paths no TS project contains (src/tokens probes,
 * apps/web before FEAT-065 creates it): the same config, minus type-aware
 * parsing, so the per-path rule blocks still decide what applies.
 */
const untypedEslint = new ESLint({
  cwd: repoRoot,
  ignore: false,
  overrideConfig: tseslint.configs.disableTypeChecked,
});

async function lintSnippet(
  path: string,
  code: string,
  ruleId = 'no-restricted-syntax',
): Promise<string[]> {
  const results = await untypedEslint.lintText(code, { filePath: resolve(repoRoot, path) });
  const messages = results.flatMap((result) => result.messages);
  const fatal = messages.filter((message) => message.fatal === true);
  if (fatal.length > 0) {
    throw new Error(
      `could not parse ${path}: ${fatal.map((message) => message.message).join('; ')}`,
    );
  }
  return byRule(messages, ruleId).map((message) => message.message);
}

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

  describe('Drshya styling (TASK-006)', () => {
    const styleViolations = async (name: string) =>
      byRule(await lintFixture(name), 'no-restricted-syntax').map((message) => ({
        line: message.line,
        message: message.message,
      }));

    it('rejects raw palette utilities, with variants, primitives and opacity', async () => {
      const violations = await styleViolations('raw-palette.tsx');

      expect(violations.map((violation) => violation.line)).toEqual([3, 4, 5, 6]);
      expect(
        violations.every((violation) => violation.message.startsWith('Raw palette utility')),
      ).toBe(true);
      expect(violations[0]?.message).toContain('plan_ui.md §9');
    }, 60_000);

    it('rejects arbitrary color values', async () => {
      const violations = await styleViolations('arbitrary-color.tsx');
      const arbitrary = violations.filter((violation) =>
        violation.message.startsWith('Arbitrary color value'),
      );

      expect(arbitrary.map((violation) => violation.line)).toEqual([2, 3]);
    }, 60_000);

    it('rejects hex and color-function literals', async () => {
      const violations = await styleViolations('color-literal.tsx');

      expect(violations.map((violation) => violation.line)).toEqual([2, 3]);
      expect(violations.every((violation) => violation.message.startsWith('Color literal'))).toBe(
        true,
      );
    }, 60_000);

    it('rejects inline style properties that are not custom properties', async () => {
      const violations = await styleViolations('inline-style.tsx');

      expect(violations).toHaveLength(1);
      expect(violations[0]?.line).toBe(2);
      expect(violations[0]?.message).toContain('Inline style');
    }, 60_000);

    it('rejects dangerouslySetInnerHTML', async () => {
      const violations = await styleViolations('inner-html.tsx');

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('dangerouslySetInnerHTML is forbidden');
    }, 60_000);

    it('still enforces the site rule in packages/ui (flat config replaces, not merges)', async () => {
      const violations = await styleViolations('site-name.tsx');

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('Website-specific logic is forbidden');
    }, 60_000);

    it('accepts semantic utilities, custom-property styles and #07-style refs', async () => {
      expect(await lintFixture('clean.tsx')).toEqual([]);
    }, 60_000);

    it('exempts the token data directory from the style selectors only', async () => {
      const tokenFile = 'packages/ui/src/tokens/in-memory-probe.ts';

      expect(
        await lintSnippet(tokenFile, "export const swatch = 'bg-red-500 oklch(0.5 0.1 200)';"),
      ).toEqual([]);
      expect(await lintSnippet(tokenFile, "export const site = 'expedia';")).toEqual([
        expect.stringContaining('Website-specific logic is forbidden'),
      ]);
      expect(
        await lintSnippet(
          'packages/ui/src/in-memory-probe.ts',
          "export const swatch = 'bg-red-500';",
        ),
      ).toEqual([expect.stringContaining('Raw palette utility')]);
    }, 60_000);

    it('applies the same rules to apps/web source', async () => {
      expect(
        await lintSnippet(
          'apps/web/src/in-memory-probe.ts',
          "export const swatch = 'text-rose-600';",
        ),
      ).toEqual([expect.stringContaining('Raw palette utility')]);
    }, 60_000);
  });

  describe('icon imports (TASK-007)', () => {
    const lucideViolations = async (path: string) =>
      byRule(
        (await eslint.lintFiles([resolve(repoRoot, path)])).flatMap((result) => result.messages),
        '@typescript-eslint/no-restricted-imports',
      ).map((message) => message.message);

    it('rejects a direct lucide-react import in a component', async () => {
      expect(await lucideViolations(`${fixtureDir}/lucide-direct.tsx`)).toEqual([
        expect.stringContaining('Import icons from the Drshya registry'),
      ]);
    }, 60_000);

    it('scopes the lucide-react exemption to registry.tsx alone', async () => {
      expect(await lucideViolations(`${fixtureDir}/registry-like.tsx`)).toEqual([
        expect.stringContaining('Import icons from the Drshya registry'),
      ]);
      expect(await lucideViolations('packages/ui/src/icons/registry.tsx')).toEqual([]);
    }, 60_000);

    it('keeps every other boundary on the registry file', async () => {
      expect(
        await lintSnippet(
          'packages/ui/src/icons/registry.tsx',
          "import { detectChrome } from '@yantra/core';\nexport const probe = detectChrome;",
          '@typescript-eslint/no-restricted-imports',
        ),
      ).toEqual([expect.stringContaining('must not import Yantra engine packages')]);
    }, 60_000);

    it('brings the icon, engine and Node restrictions to apps/web', async () => {
      const messages = await lintSnippet(
        'apps/web/src/in-memory-probe.tsx',
        [
          "import { X } from 'lucide-react';",
          "import { detectChrome } from '@yantra/core';",
          'export const probe = [X, detectChrome];',
        ].join('\n'),
        '@typescript-eslint/no-restricted-imports',
      );

      expect(messages).toEqual([
        expect.stringContaining('Import icons from the Drshya registry'),
        expect.stringContaining('must not import Yantra engine packages'),
      ]);
    }, 60_000);

    it('keeps lucide-react imports out of production source except the registry (source scan)', () => {
      const importers = productionSources().filter(
        (path) =>
          importSpecifiers(readFileSync(resolve(repoRoot, path), 'utf8')).some((specifier) =>
            specifier.startsWith('lucide-react'),
          ) && !path.replaceAll('\\', '/').endsWith('src/icons/registry.tsx'),
      );

      expect(importers).toEqual([]);
    });
  });

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
