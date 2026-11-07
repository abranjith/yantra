/**
 * Captures the user-visible CLI surface — `--help` at fixed widths, parse-error
 * stderr and exit codes, and `--version` — from any program builder.
 *
 * Shared by `scripts/capture-cli-surface.ts` (which wrote the committed goldens
 * once, from the pre-migration tree) and `cli-surface.spec.ts` (which rebuilds
 * the same files from the current tree and byte-compares them). Both sides
 * therefore run exactly one capture procedure.
 *
 * Leaf actions are replaced with a stub before parsing, so a case that
 * unexpectedly parses cleanly is recorded as `action-invoked` instead of
 * executing a real command. Replacing an action changes neither help nor parse
 * behavior.
 */

import { CommanderError, type Command } from 'commander';

import { pathFileName, walkCommandTree, type WalkedCommand } from './walk-tree.js';

/** Help widths captured for every command. */
export const HELP_WIDTHS = [80, 160] as const;

/** Width used for help printed after a parse error. */
export const ERROR_HELP_WIDTH = 80;

/** One golden file: a path relative to the fixture root and its exact bytes. */
export interface SurfaceFile {
  readonly relativePath: string;
  readonly content: string;
}

/** The observable result of one parse. */
export interface CaseOutcome {
  readonly argv: readonly string[];
  readonly exitCode: number;
  readonly code: string;
  readonly stdout: string;
  readonly stderr: string;
}

/** Builds a fresh program per case; parsing mutates option state. */
export type ProgramBuilder = () => Command;

class ActionInvokedError extends Error {
  public constructor() {
    super('a leaf action ran during surface capture');
    this.name = 'ActionInvokedError';
  }
}

/**
 * Parses `argv` against a freshly built program with every command's output
 * captured, exits overridden, and leaf actions stubbed.
 */
export async function runCase(
  build: ProgramBuilder,
  argv: readonly string[],
  width: number,
): Promise<CaseOutcome> {
  const program = build();
  let stdout = '';
  let stderr = '';
  for (const node of walkCommandTree(program)) {
    node.command.exitOverride();
    node.command.configureOutput({
      writeOut: (text) => {
        stdout += text;
      },
      writeErr: (text) => {
        stderr += text;
      },
      getOutHelpWidth: () => width,
      getErrHelpWidth: () => width,
      getOutHasColors: () => false,
      getErrHasColors: () => false,
    });
    if (node.kind === 'leaf') {
      node.command.action(() => {
        throw new ActionInvokedError();
      });
    }
  }

  try {
    await program.parseAsync([...argv], { from: 'user' });
    return { argv, exitCode: 0, code: 'ok', stdout, stderr };
  } catch (error) {
    if (error instanceof CommanderError) {
      return { argv, exitCode: error.exitCode, code: error.code, stdout, stderr };
    }
    if (error instanceof ActionInvokedError) {
      return { argv, exitCode: -1, code: 'action-invoked', stdout, stderr };
    }
    throw error;
  }
}

/** Placeholder values for a leaf's mandatory options, so other errors are reachable. */
function mandatoryOptionArgv(node: WalkedCommand): string[] {
  return node.options
    .filter((option) => option.mandatory)
    .flatMap((option) => [option.long ?? option.short ?? '', 'value']);
}

/** The parse-error cases characterized for one leaf. */
export function errorCasesFor(
  node: WalkedCommand,
): readonly { readonly name: string; readonly argv: readonly string[] }[] {
  const mandatory = mandatoryOptionArgv(node);
  const cases: { name: string; argv: readonly string[] }[] = [
    { name: 'unknown-option', argv: [...node.path, ...mandatory, '--definitely-unknown'] },
  ];
  if (node.arguments.some((argument) => argument.required)) {
    cases.push({ name: 'missing-argument', argv: [...node.path, ...mandatory] });
  }
  const last = node.arguments.at(-1);
  if (last?.variadic !== true) {
    const filled = node.arguments.map((_, index) => `arg${String(index + 1)}`);
    cases.push({
      name: 'excess-arguments',
      argv: [...node.path, ...mandatory, ...filled, 'extra'],
    });
  }
  return cases;
}

function serializeOutcome(outcome: CaseOutcome): string {
  return `${JSON.stringify(outcome, null, 2)}\n`;
}

/**
 * Produces every golden file for the program `build` returns, sorted by path.
 *
 * - `help/w<W>/<path>.txt`: stdout of `<path> --help`, for the root, every
 *   group and every leaf, plus `help/w<W>/help__<top>.txt` for
 *   `yantra help <top-level>`;
 * - `errors/<path>.<case>.json`: unknown option, missing required argument and
 *   one excess positional per leaf; `no-subcommand` per group; an unknown
 *   top-level command;
 * - `version.txt`: stdout of `--version`.
 */
export async function captureCliSurface(build: ProgramBuilder): Promise<readonly SurfaceFile[]> {
  const files: SurfaceFile[] = [];
  const nodes = [...walkCommandTree(build())];

  for (const width of HELP_WIDTHS) {
    for (const node of nodes) {
      const outcome = await runCase(build, [...node.path, '--help'], width);
      files.push({
        relativePath: `help/w${String(width)}/${pathFileName(node.path)}.txt`,
        content: helpText(outcome),
      });
    }
    for (const node of nodes.filter((candidate) => candidate.path.length === 1)) {
      const outcome = await runCase(build, ['help', node.name], width);
      files.push({
        relativePath: `help/w${String(width)}/help__${node.name}.txt`,
        content: helpText(outcome),
      });
    }
  }

  for (const node of nodes) {
    if (node.kind === 'leaf') {
      for (const errorCase of errorCasesFor(node)) {
        const outcome = await runCase(build, errorCase.argv, ERROR_HELP_WIDTH);
        files.push({
          relativePath: `errors/${pathFileName(node.path)}.${errorCase.name}.json`,
          content: serializeOutcome(outcome),
        });
      }
    } else if (node.kind === 'group') {
      const outcome = await runCase(build, node.path, ERROR_HELP_WIDTH);
      files.push({
        relativePath: `errors/${pathFileName(node.path)}.no-subcommand.json`,
        content: serializeOutcome(outcome),
      });
    }
  }
  const unknownCommand = await runCase(build, ['definitely-unknown-command'], ERROR_HELP_WIDTH);
  files.push({
    relativePath: 'errors/root.unknown-command.json',
    content: serializeOutcome(unknownCommand),
  });

  const version = await runCase(build, ['--version'], ERROR_HELP_WIDTH);
  files.push({ relativePath: 'version.txt', content: version.stdout });

  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

/** Help must reach stdout alone with exit 0; anything else is a capture defect. */
function helpText(outcome: CaseOutcome): string {
  if (outcome.exitCode !== 0 || outcome.stderr !== '') {
    throw new Error(
      `help for "${outcome.argv.join(' ')}" did not print cleanly: exit ${String(outcome.exitCode)} (${outcome.code}), stderr ${JSON.stringify(outcome.stderr)}`,
    );
  }
  return outcome.stdout;
}

/** One golden that differs from (or is missing on either side of) the capture. */
export interface SurfaceMismatch {
  readonly relativePath: string;
  readonly kind: 'changed' | 'missing-golden' | 'missing-capture';
  readonly diff: string;
}

/** Compares a capture with goldens, file set and bytes both ways. */
export function compareSurface(
  actual: readonly SurfaceFile[],
  expected: ReadonlyMap<string, string>,
): readonly SurfaceMismatch[] {
  const mismatches: SurfaceMismatch[] = [];
  const actualPaths = new Set<string>();
  for (const file of actual) {
    actualPaths.add(file.relativePath);
    const golden = expected.get(file.relativePath);
    if (golden === undefined) {
      mismatches.push({ relativePath: file.relativePath, kind: 'missing-golden', diff: '' });
    } else if (golden !== file.content) {
      mismatches.push({
        relativePath: file.relativePath,
        kind: 'changed',
        diff: unifiedDiff(golden, file.content, file.relativePath),
      });
    }
  }
  for (const path of expected.keys()) {
    if (!actualPaths.has(path)) {
      mismatches.push({ relativePath: path, kind: 'missing-capture', diff: '' });
    }
  }
  return mismatches;
}

/** A minimal line-based unified diff (single hunk, full context) for failure messages. */
export function unifiedDiff(expected: string, actual: string, label: string): string {
  const left = expected.split('\n');
  const right = actual.split('\n');
  const lcs: number[][] = Array.from({ length: left.length + 1 }, () =>
    new Array<number>(right.length + 1).fill(0),
  );
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      lcs[i]![j] =
        left[i] === right[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const lines = [`--- golden/${label}`, `+++ actual/${label}`];
  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      lines.push(` ${left[i]!}`);
      i += 1;
      j += 1;
    } else if (j < right.length && (i >= left.length || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) {
      lines.push(`+${right[j]!}`);
      j += 1;
    } else {
      lines.push(`-${left[i]!}`);
      i += 1;
    }
  }
  return lines.join('\n');
}
