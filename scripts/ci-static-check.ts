import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import ts from 'typescript';

export interface StaticCheckViolation {
  readonly kind: 'missing_sanitize_before_send';
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly callExpression: string;
}

export interface RestrictedImportViolation {
  readonly kind:
    | 'restricted_pi_agent_core_import'
    | 'restricted_pi_sdk_import_outside_adapter'
    | 'restricted_core_to_agent_import';
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly importPath: string;
}

/**
 * A rendering-toolchain import found on the `--json` render path (plan §8).
 * The `--json` output must stay dependency-free: `render/json.ts` and every
 * module reachable from it must not pull `marked`/`marked-terminal`/
 * `cli-table3`/`chalk`/`boxen`. Each violation names the offending file, the
 * restricted package, and the `--json` entrypoint whose import closure reached
 * it.
 */
export interface RestrictedRenderingImportViolation {
  readonly kind: 'restricted_rendering_import_on_json_path';
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly importPath: string;
  readonly entrypoint: string;
}

/**
 * A history/index-db import found on an LLM-payload-assembly path (FEAT-018
 * TASK-005, plan §6). The personalization privacy guarantee is enforced three
 * ways; this is the structural one: no module that assembles an LLM payload
 * (the synthesizer, the research query generator, the agent prompt builders)
 * may transitively import the `index-db` history/preference store, so raw
 * run-history text has no code path into a prompt. Same import-graph mechanism
 * as the pi-agent-core boundary and the `--json` freedom check.
 */
export interface RestrictedHistoryImportViolation {
  readonly kind: 'restricted_index_db_import_on_llm_path';
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly importPath: string;
  readonly entrypoint: string;
}

export interface StaticCheckReport {
  readonly roots: readonly string[];
  readonly checkedFileCount: number;
  readonly sendCallCount: number;
  readonly violations: readonly StaticCheckViolation[];
  readonly restrictedImportViolations: readonly RestrictedImportViolation[];
  readonly renderingImportViolations: readonly RestrictedRenderingImportViolation[];
  readonly historyImportViolations: readonly RestrictedHistoryImportViolation[];
  readonly passed: boolean;
}

export interface StaticCheckOptions {
  readonly repoRoot: string;
  readonly roots: readonly string[];
  /**
   * `--json` render-path entrypoints whose import closures must stay free of
   * the rendering toolchain. Defaults to {@link DEFAULT_JSON_PATH_ENTRIES}.
   * Overridable so the fixture suite can point the reachability walk at a
   * throwaway entry file.
   */
  readonly jsonPathEntries?: readonly string[];
  /**
   * LLM-payload-assembly entrypoints whose import closures must stay free of
   * the `index-db` history/preference store (FEAT-018 TASK-005). Defaults to
   * {@link DEFAULT_LLM_PAYLOAD_ENTRIES}. Overridable for the fixture suite.
   */
  readonly llmPayloadEntries?: readonly string[];
}

// This script enforces three build-time guards:
//
// 1. sanitize-before-send — every tracked `LLMClient.send` / `this.llm.send`
//    must be preceded by a `sanitize()` call in the same function scope.
//    Scans every `*.ts` under `roots`. Coverage of note: the LLMClient
//    adapters in `packages/agent` AND `packages/core/src/synthesis/llm.ts`
//    (the FEAT-014 LlmSynthesizer, whose injected SynthesisLlm port field is
//    named `llm`) — any un-sanitized synthesis send is a build failure.
//
// 2. pi-agent-core boundary — direct `pi-agent-core` imports are forbidden
//    outside `packages/agent`.
//
// 3. `--json` dependency-freedom (FEAT-015, plan §8) — v2 deliberately reverses
//    the MVP's "no decoration deps" stance for the *renderer only*: `marked`,
//    `marked-terminal`, `cli-table3`, `chalk`, and `boxen` are adopted for the
//    styled terminal/HTML surfaces. The machine `--json` path must stay a
//    parallel, dependency-free surface, so this guard walks the transitive
//    relative-import closure of `apps/cli/src/render/json.ts` and fails the
//    build if any reachable module imports that rendering toolchain. See
//    `checkJsonPathImports` / `RESTRICTED_RENDERING_PACKAGES`.
const DEFAULT_ROOTS = ['packages', 'apps'] as const;

/** `--json` render-path entrypoints checked for rendering-toolchain freedom. */
const DEFAULT_JSON_PATH_ENTRIES = ['apps/cli/src/render/json.ts'] as const;

/**
 * LLM-payload-assembly entrypoints whose import closures must never reach the
 * `index-db` history/preference store (FEAT-018 privacy guarantee). These are
 * every place a prompt is built from content: the LLM synthesizer, the research
 * query generator, and the agent-side prompt templates.
 */
const DEFAULT_LLM_PAYLOAD_ENTRIES = [
  'packages/core/src/synthesis/llm.ts',
  'packages/core/src/research/query-gen.ts',
  'packages/agent/src/synthesis/prompt.ts',
] as const;

/**
 * Matches an `index-db/` path segment — the history/preference store directory
 * the LLM path may not reach. Segment-based so it holds regardless of package
 * layout (and so the fixture suite can exercise it).
 */
function isIndexDbModule(repoRelativePath: string): boolean {
  return repoRelativePath.startsWith('index-db/') || repoRelativePath.includes('/index-db/');
}

/**
 * Presentation packages the `--json` path may never reach (plan §8). Matched
 * as an exact bare specifier or a subpath (`pkg/...`) — never as a prefix, so
 * `marked` does not spuriously match `marked-terminal`.
 */
const RESTRICTED_RENDERING_PACKAGES = [
  'marked',
  'marked-terminal',
  'cli-table3',
  'chalk',
  'boxen',
] as const;

export async function runStaticCheck(options: StaticCheckOptions): Promise<StaticCheckReport> {
  const repoRoot = resolve(options.repoRoot);
  const files = await collectTypeScriptFiles(repoRoot, options.roots);

  const violations: StaticCheckViolation[] = [];
  const restrictedImportViolations: RestrictedImportViolation[] = [];
  let sendCallCount = 0;

  for (const filePath of files) {
    const sourceText = await readFile(filePath, 'utf8');
    const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.ESNext, true);

    scanImports(sourceFile, repoRoot, restrictedImportViolations);

    const sendCalls = findSendCalls(sourceFile);
    sendCallCount += sendCalls.length;

    for (const sendCall of sendCalls) {
      const functionScope = findEnclosingFunction(sendCall);
      const hasSanitize = hasSanitizeBeforeCall(functionScope, sendCall, sourceFile);

      if (!hasSanitize) {
        const position = sourceFile.getLineAndCharacterOfPosition(sendCall.getStart(sourceFile));
        violations.push({
          kind: 'missing_sanitize_before_send',
          file: normalizePath(relative(repoRoot, filePath)),
          line: position.line + 1,
          column: position.character + 1,
          callExpression: sendCall.getText(sourceFile),
        });
      }
    }
  }

  const renderingImportViolations = await checkJsonPathImports(
    repoRoot,
    options.jsonPathEntries ?? DEFAULT_JSON_PATH_ENTRIES,
  );

  const historyImportViolations = await checkLlmPayloadImports(
    repoRoot,
    options.llmPayloadEntries ?? DEFAULT_LLM_PAYLOAD_ENTRIES,
  );

  return {
    roots: options.roots,
    checkedFileCount: files.length,
    sendCallCount,
    violations,
    restrictedImportViolations,
    renderingImportViolations,
    historyImportViolations,
    passed:
      violations.length === 0 &&
      restrictedImportViolations.length === 0 &&
      renderingImportViolations.length === 0 &&
      historyImportViolations.length === 0,
  };
}

/**
 * Walks the transitive relative-import closure of each LLM-payload entrypoint
 * and flags any reachable module that imports the `index-db` store. Only in-repo
 * relative imports are followed — exactly the code that ships on the prompt path
 * — so an unrelated bare import terminates a branch.
 */
async function checkLlmPayloadImports(
  repoRoot: string,
  entries: readonly string[],
): Promise<RestrictedHistoryImportViolation[]> {
  const violations: RestrictedHistoryImportViolation[] = [];

  for (const entry of entries) {
    const entryAbs = resolve(repoRoot, entry);
    if (!existsSync(entryAbs)) {
      continue;
    }

    const entryRel = normalizePath(relative(repoRoot, entryAbs));
    const visited = new Set<string>();
    const queue: string[] = [entryAbs];

    while (queue.length > 0) {
      const fileAbs = queue.shift();
      if (fileAbs === undefined || visited.has(fileAbs)) {
        continue;
      }
      visited.add(fileAbs);

      let sourceText: string;
      try {
        sourceText = await readFile(fileAbs, 'utf8');
      } catch {
        continue;
      }

      const sourceFile = ts.createSourceFile(fileAbs, sourceText, ts.ScriptTarget.ESNext, true);
      for (const specifier of collectImportSpecifiers(sourceFile)) {
        if (!specifier.path.startsWith('.')) {
          continue;
        }
        const target = resolveRelativeImport(fileAbs, specifier.path);
        if (target === null) {
          continue;
        }
        const targetRel = normalizePath(relative(repoRoot, target));
        if (isIndexDbModule(targetRel)) {
          const position = sourceFile.getLineAndCharacterOfPosition(
            specifier.node.getStart(sourceFile),
          );
          violations.push({
            kind: 'restricted_index_db_import_on_llm_path',
            file: normalizePath(relative(repoRoot, fileAbs)),
            line: position.line + 1,
            column: position.character + 1,
            importPath: specifier.path,
            entrypoint: entryRel,
          });
          continue;
        }
        queue.push(target);
      }
    }
  }

  return violations;
}

/**
 * Walks the transitive relative-import closure of each `--json` entrypoint and
 * flags any reachable module that imports the rendering toolchain. Bare
 * (package) imports other than the restricted set terminate a branch — only
 * in-repo relative imports are followed, which is exactly the code that ships
 * on the `--json` path.
 */
async function checkJsonPathImports(
  repoRoot: string,
  entries: readonly string[],
): Promise<RestrictedRenderingImportViolation[]> {
  const violations: RestrictedRenderingImportViolation[] = [];

  for (const entry of entries) {
    const entryAbs = resolve(repoRoot, entry);
    if (!existsSync(entryAbs)) {
      // A missing entrypoint is a no-op: fixture runs that don't target the
      // json-path rule pass nothing here, and a deleted json.ts is caught by
      // the build long before this script.
      continue;
    }

    const entryRel = normalizePath(relative(repoRoot, entryAbs));
    const visited = new Set<string>();
    const queue: string[] = [entryAbs];

    while (queue.length > 0) {
      const fileAbs = queue.shift();
      if (fileAbs === undefined || visited.has(fileAbs)) {
        continue;
      }
      visited.add(fileAbs);

      let sourceText: string;
      try {
        sourceText = await readFile(fileAbs, 'utf8');
      } catch {
        continue;
      }

      const sourceFile = ts.createSourceFile(fileAbs, sourceText, ts.ScriptTarget.ESNext, true);
      for (const specifier of collectImportSpecifiers(sourceFile)) {
        const restricted = matchRestrictedPackage(specifier.path);
        if (restricted !== null) {
          const position = sourceFile.getLineAndCharacterOfPosition(
            specifier.node.getStart(sourceFile),
          );
          violations.push({
            kind: 'restricted_rendering_import_on_json_path',
            file: normalizePath(relative(repoRoot, fileAbs)),
            line: position.line + 1,
            column: position.character + 1,
            importPath: specifier.path,
            entrypoint: entryRel,
          });
          continue;
        }

        if (specifier.path.startsWith('.')) {
          const target = resolveRelativeImport(fileAbs, specifier.path);
          if (target !== null) {
            queue.push(target);
          }
        }
      }
    }
  }

  return violations;
}

/** Returns the matched restricted package for an import specifier, or null. */
function matchRestrictedPackage(importPath: string): string | null {
  for (const pkg of RESTRICTED_RENDERING_PACKAGES) {
    if (importPath === pkg || importPath.startsWith(`${pkg}/`)) {
      return pkg;
    }
  }
  return null;
}

/** Every static/dynamic import + re-export module specifier in a source file. */
function collectImportSpecifiers(
  sourceFile: ts.SourceFile,
): { readonly path: string; readonly node: ts.Node }[] {
  const specifiers: { path: string; node: ts.Node }[] = [];

  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push({ path: node.moduleSpecifier.text, node });
    }

    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push({ path: node.arguments[0].text, node });
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return specifiers;
}

/**
 * Resolves an ESM relative import specifier to an on-disk `.ts` source file.
 * Handles the TS convention of importing `./foo.js` for `./foo.ts`, plus
 * extensionless and `index.ts` directory imports. Returns null when nothing
 * resolves (external types, missing files) so the walk simply stops there.
 */
function resolveRelativeImport(fromFile: string, specifier: string): string | null {
  const base = resolve(dirname(fromFile), specifier);
  const candidates: string[] = [];

  if (specifier.endsWith('.js')) {
    candidates.push(base.replace(/\.js$/, '.ts'));
  }
  if (specifier.endsWith('.mjs')) {
    candidates.push(base.replace(/\.mjs$/, '.mts'));
  }
  candidates.push(base, `${base}.ts`, join(base, 'index.ts'));

  for (const candidate of candidates) {
    if (candidate.endsWith('.ts') && existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

async function collectTypeScriptFiles(
  repoRoot: string,
  roots: readonly string[],
): Promise<string[]> {
  const rgFiles = collectWithRipgrep(repoRoot, roots);
  if (rgFiles !== null) {
    return rgFiles;
  }

  const collected: string[] = [];
  for (const root of roots) {
    const rootPath = resolve(repoRoot, root);
    await walkTypeScriptFiles(rootPath, collected);
  }
  return collected;
}

function collectWithRipgrep(repoRoot: string, roots: readonly string[]): string[] | null {
  const args = [
    '--files',
    '-g',
    '*.ts',
    '-g',
    '!**/node_modules/**',
    '-g',
    '!**/dist/**',
    '-g',
    '!**/.turbo/**',
    '-g',
    '!**/coverage/**',
    '-g',
    '!**/_lint-fixtures/**',
    ...roots,
  ];

  const result = spawnSync('rg', args, { cwd: repoRoot, encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    return null;
  }

  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.endsWith('.ts') && !line.endsWith('.d.ts'))
    .map((line) => resolve(repoRoot, line));
}

async function walkTypeScriptFiles(currentPath: string, files: string[]): Promise<void> {
  const entries = await readdir(currentPath, { withFileTypes: true }).catch(() => []);

  for (const entry of entries) {
    const fullPath = join(currentPath, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.turbo') {
        continue;
      }
      if (entry.name === '_lint-fixtures') {
        continue;
      }
      await walkTypeScriptFiles(fullPath, files);
      continue;
    }

    if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      files.push(fullPath);
    }
  }
}

/** The only agent-SDK package Yantra may depend on (plan_agentic.md §3). */
const PI_SDK_PACKAGE = '@earendil-works/pi-coding-agent';

/** Directories (source + mirrored tests) allowed to import the Pi SDK. */
const PI_SDK_ALLOWED_PREFIXES = [
  'packages/agent/src/adapters/pi/',
  'packages/agent/tests/adapters/pi/',
] as const;

function matchesPackage(importPath: string, packageName: string): boolean {
  return importPath === packageName || importPath.startsWith(`${packageName}/`);
}

function scanImports(
  sourceFile: ts.SourceFile,
  repoRoot: string,
  collector: RestrictedImportViolation[],
): void {
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const importPath = node.moduleSpecifier.text;
      const normalizedFile = normalizePath(relative(repoRoot, sourceFile.fileName));
      const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      const violation = {
        file: normalizedFile,
        line: position.line + 1,
        column: position.character + 1,
        importPath,
      };

      // Legacy SDK name: forbidden outside packages/agent (removed by FEAT-029).
      if (
        matchesPackage(importPath, 'pi-agent-core') &&
        !normalizedFile.startsWith('packages/agent/')
      ) {
        collector.push({ kind: 'restricted_pi_agent_core_import', ...violation });
      }

      // Pi SDK: confined to the adapter directory (plan_agentic.md §3).
      if (
        matchesPackage(importPath, PI_SDK_PACKAGE) &&
        !PI_SDK_ALLOWED_PREFIXES.some((prefix) => normalizedFile.startsWith(prefix))
      ) {
        collector.push({ kind: 'restricted_pi_sdk_import_outside_adapter', ...violation });
      }

      // Dependency direction: core must never import agent (plan_agentic.md §3).
      if (
        matchesPackage(importPath, '@yantra/agent') &&
        normalizedFile.startsWith('packages/core/')
      ) {
        collector.push({ kind: 'restricted_core_to_agent_import', ...violation });
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
}

function findSendCalls(sourceFile: ts.SourceFile): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isTrackedSendCall(node.expression, sourceFile)) {
      calls.push(node);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return calls;
}

function isTrackedSendCall(
  expression: ts.LeftHandSideExpression,
  sourceFile: ts.SourceFile,
): boolean {
  if (ts.isPropertyAccessExpression(expression) && expression.name.text === 'send') {
    const ownerText = expression.expression.getText(sourceFile);
    return ownerText === 'LLMClient' || ownerText === 'this.llm';
  }

  if (
    ts.isElementAccessExpression(expression) &&
    expression.argumentExpression?.getText(sourceFile) === '"send"'
  ) {
    const ownerText = expression.expression.getText(sourceFile);
    return ownerText === 'LLMClient' || ownerText === 'this.llm';
  }

  return false;
}

function findEnclosingFunction(node: ts.Node): ts.Node {
  let current: ts.Node | undefined = node;

  while (current?.parent) {
    if (ts.isFunctionLike(current.parent)) {
      return current.parent;
    }
    current = current.parent;
  }

  return node.getSourceFile();
}

function hasSanitizeBeforeCall(
  functionScope: ts.Node,
  targetCall: ts.CallExpression,
  sourceFile: ts.SourceFile,
): boolean {
  const targetPos = targetCall.getStart(sourceFile);
  let found = false;

  const root = ts.isFunctionLike(functionScope)
    ? (functionScope.body ?? functionScope)
    : functionScope;

  const visit = (node: ts.Node): void => {
    if (found) {
      return;
    }

    if (node !== root && ts.isFunctionLike(node)) {
      return;
    }

    if (node.getStart(sourceFile) >= targetPos) {
      return;
    }

    if (ts.isCallExpression(node) && isSanitizeCall(node.expression)) {
      found = true;
      return;
    }

    ts.forEachChild(node, visit);
  };

  visit(root);
  return found;
}

function isSanitizeCall(expression: ts.LeftHandSideExpression): boolean {
  if (ts.isIdentifier(expression)) {
    return expression.text === 'sanitize';
  }

  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text === 'sanitize';
  }

  return false;
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function parseCliArgs(argv: readonly string[]): StaticCheckOptions {
  const args = [...argv];

  let repoRoot = process.cwd();
  let roots: string[] = [...DEFAULT_ROOTS];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    if (arg === '--repo-root') {
      const value = args[i + 1];
      if (!value) {
        throw new Error('--repo-root requires a value');
      }
      repoRoot = isAbsolute(value) ? value : resolve(process.cwd(), value);
      i += 1;
      continue;
    }

    if (arg === '--roots') {
      const value = args[i + 1];
      if (!value) {
        throw new Error('--roots requires a comma-separated value');
      }
      roots = value
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
      i += 1;
      continue;
    }
  }

  return {
    repoRoot,
    roots,
  };
}

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));
  const report = await runStaticCheck(options);

  process.stderr.write(`${JSON.stringify(report, null, 2)}\n`);

  if (!report.passed) {
    process.exitCode = 1;
  }
}

const executedAsScript =
  process.argv[1] !== undefined &&
  pathToFileURL(fileURLToPath(import.meta.url)).href === pathToFileURL(process.argv[1]).href;

if (executedAsScript) {
  void main();
}
