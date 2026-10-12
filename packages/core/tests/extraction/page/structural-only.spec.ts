/**
 * Boundary: page analysis is structural only (FEAT-051, memory → never write
 * website-specific logic).
 *
 * No module under `src/extraction/page/` may read a `class` or `id`
 * attribute, name a host, or branch on a site token. Comments are exempt,
 * matching the lint rule: a site may be cited there as evidence for a general
 * rule.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import ts from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';

const PAGE_DIR = resolve(import.meta.dirname, '../../../src/extraction/page');
const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');

/** The repository's one site-token list (`eslint.config.js`), loaded once. */
let siteTokens = /$^/u;

/** Patterns that read a class or id, in any spelling the DOM APIs offer. */
const ATTRIBUTE_READS: readonly RegExp[] = [
  /attr\(\s*['"](?:class|id)['"]\s*\)/u,
  /\.hasClass\(/u,
  /\[class/u,
  /\[id/u,
  /classList/u,
  /className/u,
  /attribs\s*(?:\.\s*(?:class|id)\b|\[\s*['"](?:class|id)['"]\s*\])/u,
  /attrOf\(\s*[\w.]+\s*,\s*['"](?:class|id)['"]\s*\)/u,
];

/** A string literal that looks like a hostname. */
const HOSTNAME_LITERAL = /\b[a-z0-9-]+\.(?:com|net|org|io|co)\b/u;

/**
 * Violations in one source text. The TypeScript parser does the reading, so
 * comments are exempt exactly as the lint rule exempts them, and a quote
 * inside a regex literal cannot hide a string from the scan.
 */
function structuralViolations(source: string): string[] {
  const file = ts.createSourceFile('module.ts', source, ts.ScriptTarget.Latest, true);
  const code = ts.createPrinter({ removeComments: true }).printFile(file);
  const literals: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteralLike(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      literals.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  const found: string[] = [];
  for (const pattern of ATTRIBUTE_READS) {
    if (pattern.test(code)) found.push(`reads a class or id: ${pattern.source}`);
  }
  for (const literal of literals) {
    if (HOSTNAME_LITERAL.test(literal)) found.push(`hostname literal: ${literal}`);
  }
  if (siteTokens.test(code)) found.push('site token');
  return found;
}

describe('@no-llm extraction/page is structural only', () => {
  beforeAll(async () => {
    const config = (await import(pathToFileURL(join(REPO_ROOT, 'eslint.config.js')).href)) as {
      readonly SITE_TOKEN_SOURCE?: unknown;
    };
    if (typeof config.SITE_TOKEN_SOURCE !== 'string' || config.SITE_TOKEN_SOURCE.length === 0) {
      throw new Error('eslint.config.js must export SITE_TOKEN_SOURCE as a non-empty string.');
    }
    siteTokens = new RegExp(config.SITE_TOKEN_SOURCE, 'iu');
    // Loading the config loads every lint plugin; size the hook for that.
  }, 60_000);

  it('fails on a synthetic module that reads a class', () => {
    expect(structuralViolations("const c = $(el).attr('class');")).not.toEqual([]);
    expect(structuralViolations('if (node.attribs.id === "x") {}')).not.toEqual([]);
    expect(structuralViolations("if (attrOf(node, 'class')) {}")).not.toEqual([]);
    expect(structuralViolations("$('[class*=card]')")).not.toEqual([]);
    expect(structuralViolations("if (url.includes('shop.com')) {}")).not.toEqual([]);
    expect(structuralViolations(`const s = '${'ex' + 'pedia'}';`)).not.toEqual([]);
    expect(structuralViolations("const r = /['\"]/u; const h = `on ${'x'} shop.com`;")).not.toEqual(
      [],
    );
  });

  it('exempts comments', () => {
    expect(
      structuralViolations("// seen on shop.com: attr('class') was tempting\nconst x = 1;"),
    ).toEqual([]);
    expect(structuralViolations('/* .hasClass( is forbidden */ const y = 2;')).toEqual([]);
  });

  it('passes on every module under src/extraction/page', () => {
    const files = readdirSync(PAGE_DIR).filter((name) => name.endsWith('.ts'));
    expect(files.length).toBeGreaterThanOrEqual(9);
    for (const name of files) {
      expect({
        file: name,
        violations: structuralViolations(readFileSync(join(PAGE_DIR, name), 'utf8')),
      }).toEqual({
        file: name,
        violations: [],
      });
    }
  });
});
