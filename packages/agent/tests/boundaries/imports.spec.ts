/**
 * Architectural boundary tests for FEAT-022 (plan_agentic.md §3):
 *
 *   1. `@earendil-works/pi-coding-agent`, including its image types, may be imported only under
 *      `packages/agent/src/adapters/pi/` (mirrored tests under
 *      `packages/agent/tests/adapters/pi/` may import it for stubbing).
 *   2. `packages/core` must never import `@yantra/agent` — the dependency
 *      direction is protocol -> core -> agent -> cli.
 *
 * The scan reads TypeScript import/export/dynamic-import/require syntax
 * (including type imports) so it holds regardless of tsconfig project membership, and it
 * skips `_lint-fixtures` directories, which intentionally violate the rules.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

const PI_SDK_PACKAGE = '@earendil-works/pi-coding-agent';

const PI_SDK_ALLOWED_PREFIXES = [
  'packages/agent/src/adapters/pi/',
  'packages/agent/tests/adapters/pi/',
];

const SKIPPED_DIRS = new Set(['node_modules', 'dist', '.turbo', 'coverage', '_lint-fixtures']);

function collectTsFiles(root: string, collected: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return collected;
  }

  for (const entry of entries) {
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) {
        collectTsFiles(fullPath, collected);
      }
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      collected.push(fullPath);
    }
  }

  return collected;
}

/** Inspect actual imports, including type imports; quoted fixture code is ordinary data. */
function importsPackage(sourceText: string, packageName: string): boolean {
  const source = ts.createSourceFile(
    'boundary.ts',
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const matches = (node: ts.Node | undefined) =>
    node !== undefined &&
    (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
    (node.text === packageName || node.text.startsWith(`${packageName}/`));
  let found = false;
  function visit(node: ts.Node): void {
    if (found) return;
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      matches(node.moduleSpecifier)
    )
      found = true;
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      matches(node.moduleReference.expression)
    )
      found = true;
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      matches(node.argument.literal)
    )
      found = true;
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
      matches(node.arguments[0])
    )
      found = true;
    ts.forEachChild(node, visit);
  }
  visit(source);
  return found;
}

function normalize(filePath: string): string {
  return relative(repoRoot, filePath).replace(/\\/g, '/');
}

describe('@no-llm FEAT-022 boundary rules', () => {
  it('distinguishes imports from comments and quoted negative fixtures', () => {
    const statement = `import {Agent} from '${PI_SDK_PACKAGE}';`;
    expect(
      importsPackage(`const fixture=${JSON.stringify(statement)}; // ${statement}`, PI_SDK_PACKAGE),
    ).toBe(false);
    for (const code of [
      statement,
      `export {Agent} from '${PI_SDK_PACKAGE}/types';`,
      `const module=import('${PI_SDK_PACKAGE}');`,
      `const module=require('${PI_SDK_PACKAGE}');`,
      `type Agent=import('${PI_SDK_PACKAGE}').Agent;`,
      `import Agent=require('${PI_SDK_PACKAGE}');`,
    ])
      expect(importsPackage(code, PI_SDK_PACKAGE)).toBe(true);
  });

  it(`confines ${PI_SDK_PACKAGE} imports to packages/agent/src/adapters/pi/`, () => {
    const scanRoots = [resolve(repoRoot, 'packages'), resolve(repoRoot, 'apps')];
    const files = scanRoots.flatMap((root) => collectTsFiles(root));

    const offenders = files
      .filter((file) => importsPackage(readFileSync(file, 'utf8'), PI_SDK_PACKAGE))
      .map(normalize)
      .filter((file) => !PI_SDK_ALLOWED_PREFIXES.some((prefix) => file.startsWith(prefix)));

    // A non-empty list means the Pi SDK leaked outside the adapter directory.
    expect(offenders).toEqual([]);
  });

  it('keeps packages/core free of @yantra/agent imports', () => {
    const files = collectTsFiles(resolve(repoRoot, 'packages/core'));

    const offenders = files
      .filter((file) => importsPackage(readFileSync(file, 'utf8'), '@yantra/agent'))
      .map(normalize);

    // A non-empty list means core imported agent (forbidden direction).
    expect(offenders).toEqual([]);
  });

  it('keeps FEAT-036 production sources generic and free of site-specific branches', () => {
    const featureSources = [
      'packages/agent/src/runtime/vision.ts',
      'packages/agent/src/adapters/pi/tools/browser-screenshot.ts',
      'packages/core/src/browser/sensitive-screen-latch.ts',
      'packages/core/src/browser/set-of-marks.ts',
    ];
    const siteSpecific =
      /https?:\/\/|www\.|\.(?:com|net|org)\b|\b(?:google|kayak|expedia|amazon|fedex)\b/iu;
    const offenders = featureSources.filter((file) =>
      siteSpecific.test(readFileSync(resolve(repoRoot, file), 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
