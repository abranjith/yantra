/**
 * No swallowed errors on a tool's run path (FEAT-048 TASK-003).
 *
 * Run `20260925T130634Z` lost eleven typed search causes to one bare
 * `catch {}`. Memory → Coding Standards: "Never silently swallow errors." This
 * test makes that rule mechanical for the tool adapters and the middleware: a
 * catch clause without a binding, or a `.catch(() => undefined)` /
 * `.catch(() => {})`, passes only when its block maps to a stable code
 * (`errorCode`), logs (`logger.` / `runtimeLogger`), or rethrows — or when the
 * site carries an inline `// swallow-ok: <reason>` justification.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const agentRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** The files on a tool's run path. */
function scannedFiles(): string[] {
  const toolsDir = join(agentRoot, 'src', 'adapters', 'pi', 'tools');
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.ts')) files.push(path);
    }
  };
  walk(toolsDir);
  files.push(join(agentRoot, 'src', 'runtime', 'middleware.ts'));
  return files;
}

const BARE_CATCH_RE = /\bcatch\s*\{/g;
const SILENT_PROMISE_CATCH_RE = /\.catch\(\s*\(\s*\)\s*=>\s*(?:undefined|\{\s*\})\s*\)/g;
const SWALLOW_OK_RE = /\/\/\s*swallow-ok:\s*\S/;
const HANDLED_RE = /\berrorCode\b|\blogger\.|\bruntimeLogger\b|\brethrow\b|\bthrow\b/;

/** The text of the block opened by the `{` at `openIndex`, braces matched. */
function blockAt(source: string, openIndex: number): string {
  let depth = 0;
  for (let i = openIndex; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex, i + 1);
    }
  }
  return source.slice(openIndex);
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

/** JSDoc and line comments may name the pattern they forbid. */
function isCommentLine(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*');
}

function lineText(source: string, line: number): string {
  return source.split('\n')[line - 1] ?? '';
}

/**
 * Offending sites in one source text, as `label:line`.
 *
 * @param source File contents.
 * @param label Path used in the report.
 */
function swallowOffenders(source: string, label: string): string[] {
  const offenders: string[] = [];
  for (const match of source.matchAll(BARE_CATCH_RE)) {
    if (isCommentLine(lineText(source, lineOf(source, match.index)))) continue;
    const open = match.index + match[0].length - 1;
    const block = blockAt(source, open);
    const firstLines = block.split('\n').slice(0, 2).join('\n');
    if (SWALLOW_OK_RE.test(firstLines) || HANDLED_RE.test(block)) continue;
    offenders.push(`${label}:${lineOf(source, match.index)}`);
  }
  for (const match of source.matchAll(SILENT_PROMISE_CATCH_RE)) {
    const line = lineOf(source, match.index);
    if (isCommentLine(lineText(source, line))) continue;
    const context = `${lineText(source, line - 1)}\n${lineText(source, line)}`;
    if (SWALLOW_OK_RE.test(context)) continue;
    offenders.push(`${label}:${line}`);
  }
  return offenders;
}

describe('@no-llm boundary: no swallowed errors on the tool run path', () => {
  it('every bare catch in the tool adapters and middleware maps, logs, rethrows, or is justified', () => {
    const offenders = scannedFiles().flatMap((path) =>
      swallowOffenders(readFileSync(path, 'utf8'), relative(agentRoot, path)),
    );

    expect(offenders).toEqual([]);
  });

  it('flags an unannotated bare catch in a synthetic fixture', () => {
    const fixture = [
      'async function run() {',
      '  try {',
      '    await search();',
      '  } catch {',
      "    return { ok: false, message: 'temporarily unavailable' };",
      '  }',
      '  await cleanup().catch(() => undefined);',
      '  await other().catch(() => {});',
      '}',
    ].join('\n');

    expect(swallowOffenders(fixture, 'fixture.ts')).toEqual([
      'fixture.ts:4',
      'fixture.ts:7',
      'fixture.ts:8',
    ]);
  });

  it('accepts a mapped, logged, rethrown, or justified site', () => {
    const fixture = [
      'try { a(); } catch {',
      "  return { ok: false, errorCode: 'X', message: 'm', retryable: false };",
      '}',
      'try { b(); } catch {',
      "  logger.warn({}, 'x');",
      '}',
      'try { c(); } catch {',
      "  throw new Error('x');",
      '}',
      'try { d(); } catch {',
      '  // swallow-ok: URL parse helper',
      '  return null;',
      '}',
      '// swallow-ok: best-effort cleanup',
      'await e().catch(() => undefined);',
    ].join('\n');

    expect(swallowOffenders(fixture, 'fixture.ts')).toEqual([]);
  });

  it('does not accept a swallow-ok marker without a reason', () => {
    const fixture = ['try { a(); } catch {', '  // swallow-ok:', '  return null;', '}'].join('\n');

    expect(swallowOffenders(fixture, 'fixture.ts')).toEqual(['fixture.ts:1']);
  });
});
