import { spawnSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
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
  readonly kind: 'restricted_pi_agent_core_import';
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly importPath: string;
}

export interface StaticCheckReport {
  readonly roots: readonly string[];
  readonly checkedFileCount: number;
  readonly sendCallCount: number;
  readonly violations: readonly StaticCheckViolation[];
  readonly restrictedImportViolations: readonly RestrictedImportViolation[];
  readonly passed: boolean;
}

export interface StaticCheckOptions {
  readonly repoRoot: string;
  readonly roots: readonly string[];
}

const DEFAULT_ROOTS = ['packages', 'apps'] as const;

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

  return {
    roots: options.roots,
    checkedFileCount: files.length,
    sendCallCount,
    violations,
    restrictedImportViolations,
    passed: violations.length === 0 && restrictedImportViolations.length === 0,
  };
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

function scanImports(
  sourceFile: ts.SourceFile,
  repoRoot: string,
  collector: RestrictedImportViolation[],
): void {
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const importPath = node.moduleSpecifier.text;
      if (importPath === 'pi-agent-core' || importPath.startsWith('pi-agent-core/')) {
        const normalizedFile = normalizePath(relative(repoRoot, sourceFile.fileName));
        if (!normalizedFile.startsWith('packages/agent/')) {
          const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          collector.push({
            kind: 'restricted_pi_agent_core_import',
            file: normalizedFile,
            line: position.line + 1,
            column: position.character + 1,
            importPath,
          });
        }
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
