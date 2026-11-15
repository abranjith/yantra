/**
 * Copied commands execute correctly in real shells (FEAT-062 TASK-011).
 *
 * Every formatted invocation runs in bash (Git Bash on Windows), Windows
 * PowerShell 5.1 and cmd, through launchers shaped like the npm/pnpm cmd-shim
 * templates (https://github.com/npm/cmd-shim/blob/main/lib/index.js) and
 * through `node <absolute path>`. The launchers run `fixtures/argv-echo`,
 * which records the argv it received, and the suite compares that with the
 * invocation's path and argv. A shell that is not installed is skipped with
 * the reason in the test name; cmd cases the formatter marks unrepresentable
 * assert that reason instead of executing.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  COMMAND_REGISTRY,
  expandOptions,
  formatInvocation,
  parseInvocation,
  type CommandInvocation,
  type LeafEntry,
  type Shell,
} from '@yantra/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ECHO,
  findBash,
  findCmd,
  findPowerShell,
  launcherEnv,
  readEcho,
  writeLaunchers,
} from './fixtures/argv-echo/shells.js';

const CWD = process.cwd();

/** Values that stress every shell's quoting. */
const SPECIAL_VALUES: readonly string[] = [
  'say "hi"',
  "it's",
  '$HOME',
  '$(echo injected)',
  'a`b',
  '50%',
  '%PATH%',
  'a^b',
  'wow!',
  'line\nbreak',
  '',
  '-leading-dash',
  'café 東京',
  'a&b|c<d>e',
  'C:\\dir\\',
  'a b\\',
  'back\\"slash',
  'tab\there',
  'semi;colon,comma=eq',
  '@splat',
  '(paren) {brace} [bracket]',
];

interface Case {
  readonly name: string;
  readonly invocation: CommandInvocation;
}

function invocationFor(argv: readonly string[]): CommandInvocation {
  const parsed = parseInvocation(argv, { cwd: CWD });
  if (!parsed.isOk) throw new Error(`corpus argv does not parse: ${JSON.stringify(argv)}`);
  return parsed.value.invocation;
}

/** One valid invocation per leaf: required arguments, mandatory options, one spaced value. */
function leafCase(entry: LeafEntry): Case {
  const argv: string[] = [...entry.path];
  for (const argument of entry.arguments) {
    if (!argument.required) continue;
    argv.push(argument.input.kind === 'enum' ? argument.input.choices[0] : 'value one');
  }
  const options = expandOptions(entry, COMMAND_REGISTRY.option_groups);
  for (const option of options.filter((candidate) => candidate.mandatory)) {
    argv.push(option.long, '0 8 * * 1');
  }
  const free = options.find(
    (option) => option.value === 'required' && !option.mandatory && option.input.kind === 'text',
  );
  if (free !== undefined) argv.push(free.long, 'spaced value');
  return { name: entry.id, invocation: invocationFor(argv) };
}

const CORPUS: readonly Case[] = [
  ...COMMAND_REGISTRY.commands
    .filter((entry): entry is LeafEntry => entry.kind === 'leaf')
    .map(leafCase),
  ...SPECIAL_VALUES.map((value) => ({
    name: `show -- ${JSON.stringify(value)}`,
    invocation: invocationFor(['show', '--', value]),
  })),
];

const BASH = findBash();
const POWERSHELL = findPowerShell();
const CMD = findCmd();

let work = '';
let bin = '';

function childEnv(): NodeJS.ProcessEnv {
  return launcherEnv(bin);
}

function expectedArgv(invocation: CommandInvocation): string[] {
  return [...invocation.path, ...invocation.argv];
}

interface Program {
  readonly label: string;
  readonly tokens: readonly string[];
  /** Shells this form is run in, with the reason it is not run elsewhere. */
  readonly shells: readonly Shell[];
  readonly skipReason?: string;
}

const ALL_SHELLS: readonly Shell[] = ['posix', 'powershell', 'cmd'];

const PROGRAMS: readonly Program[] = [
  { label: 'launcher', tokens: ['yantra'], shells: ALL_SHELLS },
  { label: 'node', tokens: ['node', ECHO], shells: ALL_SHELLS },
  {
    // PowerShell resolves `yantra` to the .ps1 launcher; this form forces the
    // .cmd one, which re-reads the command line through cmd.
    label: 'cmd-launcher',
    tokens: ['yantra.cmd'],
    shells: ['powershell', 'cmd'],
    skipReason: 'bash resolves `yantra` to the sh launcher, never the .cmd one',
  },
];

/**
 * What cmd itself cannot carry when PowerShell runs a `.cmd` launcher: it
 * expands `%VAR%` and ends the command at a line break. Recorded as a spec
 * DEVIATION; the suite asserts these cases still fail, so a change is noticed.
 */
const THROUGH_CMD_LIMIT = /%[^%]+%|[\r\n]/;

function isKnownLimit(program: Program, shell: Shell, item: Case): boolean {
  return (
    program.label === 'cmd-launcher' &&
    shell === 'powershell' &&
    expectedArgv(item.invocation).some((token) => THROUGH_CMD_LIMIT.test(token))
  );
}

/** Compares every echoed argv with its invocation for one shell and program. */
function compareEchoes(shell: Shell, program: Program) {
  const mismatches: unknown[] = [];
  const limits: string[] = [];
  const limitsCarried: string[] = [];
  CORPUS.forEach((item, index) => {
    const actual = readEcho(outFile(shell, program.label, index));
    const expected = expectedArgv(item.invocation);
    const same = JSON.stringify(actual) === JSON.stringify(expected);
    if (isKnownLimit(program, shell, item)) {
      limits.push(item.name);
      if (same) limitsCarried.push(item.name);
    } else if (!same) {
      mismatches.push({ case: item.name, expected, actual });
    }
  });
  return { mismatches, limitsCarried, limitCount: limits.length };
}

function outFile(shell: Shell, program: string, index: number): string {
  return join(work, `${shell}-${program}-${String(index)}.json`);
}

function formatted(invocation: CommandInvocation, shell: Shell, program: Program): string {
  const result = formatInvocation(invocation, shell, { program: [...program.tokens] });
  if (!result.ok) throw new Error(`${shell} refused: ${result.detail}`);
  return result.text;
}

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'yantra-format-shells-'));
  bin = join(work, 'bin');
  mkdirSync(bin);
  writeLaunchers(bin);
});

afterAll(() => {
  if (work !== '') rmSync(work, { recursive: true, force: true });
});

describe('@no-llm copied commands run in real shells', () => {
  it('builds a corpus with every leaf and every special value', () => {
    const leaves = COMMAND_REGISTRY.commands.filter((entry) => entry.kind === 'leaf');
    expect(CORPUS).toHaveLength(leaves.length + SPECIAL_VALUES.length);
  });

  describe.each(PROGRAMS)('program: $label', (program) => {
    const bashSkip =
      BASH === null
        ? 'bash not found; on Windows only Git Bash qualifies'
        : program.shells.includes('posix')
          ? null
          : (program.skipReason ?? 'not run in bash');
    it.skipIf(bashSkip !== null)(
      `bash${bashSkip === null ? '' : ` (skipped: ${bashSkip})`}`,
      () => {
        const lines = CORPUS.flatMap((item, index) => [
          `export ARGV_ECHO_OUT='${outFile('posix', program.label, index).replace(/\\/g, '/')}'`,
          formatted(item.invocation, 'posix', program),
        ]);
        const script = join(work, `run-${program.label}.sh`);
        writeFileSync(script, `${lines.join('\n')}\n`);
        const run = spawnSync(BASH!, ['--noprofile', '--norc', script], {
          env: childEnv(),
          encoding: 'utf8',
          timeout: 120_000,
        });
        const { mismatches } = compareEchoes('posix', program);
        expect({ status: run.status, stderr: run.stderr, mismatches }).toEqual({
          status: 0,
          stderr: '',
          mismatches: [],
        });
      },
      150_000,
    );

    it.skipIf(POWERSHELL === null)(
      `PowerShell 5.1${POWERSHELL === null ? ' (skipped: Windows PowerShell 5.1 exists only on Windows)' : ''}`,
      () => {
        const lines = CORPUS.flatMap((item, index) => [
          `$env:ARGV_ECHO_OUT = '${outFile('powershell', program.label, index)}'`,
          formatted(item.invocation, 'powershell', program),
        ]);
        const script = join(work, `run-${program.label}.ps1`);
        // 5.1 reads a BOM-less script in the ANSI code page.
        writeFileSync(script, `\uFEFF${lines.join('\r\n')}\r\n`, 'utf8');
        const run = spawnSync(
          POWERSHELL!,
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
          { env: childEnv(), encoding: 'utf8', timeout: 120_000 },
        );
        const { mismatches, limitsCarried, limitCount } = compareEchoes('powershell', program);
        expect({ mismatches, limitsCarried }).toEqual({ mismatches: [], limitsCarried: [] });
        if (program.label === 'cmd-launcher') {
          expect(limitCount).toBeGreaterThan(0);
        } else {
          // cmd is not involved, so PowerShell itself must carry every value.
          expect({ status: run.status, stderr: run.stderr }).toEqual({ status: 0, stderr: '' });
        }
      },
      150_000,
    );

    it.skipIf(CMD === null)(
      `cmd${CMD === null ? ' (skipped: cmd exists only on Windows)' : ''}`,
      () => {
        const mismatches: unknown[] = [];
        let refused = 0;
        CORPUS.forEach((item, index) => {
          const result = formatInvocation(item.invocation, 'cmd', { program: [...program.tokens] });
          if (!result.ok) {
            // Only the characters cmd cannot carry may make it unavailable.
            expect(result.reason).toBe('shell_unrepresentable');
            // eslint-disable-next-line no-control-regex
            expect(expectedArgv(item.invocation).some((t) => /[\r\n"%\u0000-\u001f]/.test(t))).toBe(
              true,
            );
            refused += 1;
            return;
          }
          const out = outFile('cmd', program.label, index);
          const env = { ...childEnv(), ARGV_ECHO_OUT: out };
          spawnSync(CMD!, ['/d', '/s', '/c', `"${result.text}"`], {
            env,
            windowsVerbatimArguments: true,
            encoding: 'utf8',
            timeout: 30_000,
          });
          const actual = readEcho(out);
          const expected = expectedArgv(item.invocation);
          if (JSON.stringify(actual) !== JSON.stringify(expected)) {
            mismatches.push({ case: item.name, line: result.text, expected, actual });
          }
        });
        expect(mismatches).toEqual([]);
        expect(refused).toBeGreaterThan(0);
      },
      300_000,
    );
  });
});
