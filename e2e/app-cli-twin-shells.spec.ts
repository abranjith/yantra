// @no-llm
/**
 * The cockpit's CLI twin, pasted into a real shell, starts the identical
 * command (FEAT-067 TASK-007; acceptance "The CLI twin, pasted into the
 * default shell, starts the identical command").
 *
 * The twin text is exactly what the app shows and copies: FEAT-062's
 * `formatInvocation(invocation, shell)` with the default program `yantra`
 * (apps/web `formatTwin`). A `yantra` launcher on PATH records its argv; each
 * shell's recorded argv must equal the invocation's path and argv. A shell
 * that is not installed is skipped with the reason in the test name.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { formatInvocation, parseInvocation, type CommandInvocation } from '@yantra/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  findBash,
  findCmd,
  findPowerShell,
  launcherEnv,
  readEcho,
  writeLaunchers,
} from './fixtures/argv-echo/shells.js';

/** The goal the spec names: a quote, a dollar, backticks and a percent sign. */
const GOAL = "q's $x `y` 100%";

function twinOf(argv: readonly string[]): CommandInvocation {
  const parsed = parseInvocation(argv, { cwd: process.cwd() });
  if (!parsed.isOk) throw new Error(parsed.error.message);
  return parsed.value.invocation;
}

const RESEARCH = twinOf(['research', GOAL, '--no-llm']);
/** The same goal without the percent sign, which cmd cannot carry. */
const RESEARCH_FOR_CMD = twinOf(['research', "q's $x `y` 100", '--no-llm']);
const MULTILINE = twinOf(['ask', 'first line\nsecond line', '--no-llm']);

const BASH = findBash();
const POWERSHELL = findPowerShell();
const CMD = findCmd();

let work = '';
let bin = '';

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'yantra-twin-shells-'));
  bin = join(work, 'bin');
  mkdirSync(bin);
  writeLaunchers(bin);
});

afterAll(() => {
  if (work !== '') rmSync(work, { recursive: true, force: true });
});

function text(invocation: CommandInvocation, shell: 'posix' | 'powershell' | 'cmd'): string {
  const result = formatInvocation(invocation, shell);
  if (!result.ok) throw new Error(`${shell}: ${result.detail}`);
  return result.text;
}

function expected(invocation: CommandInvocation): string[] {
  return [...invocation.path, ...invocation.argv];
}

describe('@no-llm the copied CLI twin runs the same command', () => {
  it.skipIf(BASH === null)(
    `in bash${BASH === null ? ' (skipped: bash not found; on Windows only Git Bash qualifies)' : ''}`,
    () => {
      const out = join(work, 'posix.json').replace(/\\/g, '/');
      const script = join(work, 'twin.sh');
      writeFileSync(script, `export ARGV_ECHO_OUT='${out}'\n${text(RESEARCH, 'posix')}\n`);

      const run = spawnSync(BASH!, ['--noprofile', '--norc', script], {
        env: launcherEnv(bin),
        encoding: 'utf8',
        timeout: 60_000,
      });

      expect({ status: run.status, argv: readEcho(out) }).toEqual({
        status: 0,
        argv: expected(RESEARCH),
      });
    },
    90_000,
  );

  it.skipIf(POWERSHELL === null)(
    `in PowerShell 5.1${POWERSHELL === null ? ' (skipped: Windows PowerShell 5.1 exists only on Windows)' : ''}`,
    () => {
      const out = join(work, 'powershell.json');
      const script = join(work, 'twin.ps1');
      // 5.1 reads a BOM-less script in the ANSI code page.
      writeFileSync(
        script,
        `\uFEFF$env:ARGV_ECHO_OUT = '${out}'\r\n${text(RESEARCH, 'powershell')}\r\n`,
        'utf8',
      );

      const run = spawnSync(
        POWERSHELL!,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
        { env: launcherEnv(bin), encoding: 'utf8', timeout: 60_000 },
      );

      expect({ status: run.status, argv: readEcho(out) }).toEqual({
        status: 0,
        argv: expected(RESEARCH),
      });
    },
    90_000,
  );

  it.skipIf(CMD === null)(
    `in cmd${CMD === null ? ' (skipped: cmd exists only on Windows)' : ''}`,
    () => {
      // cmd is not an available shell for this goal: the twin says why instead.
      expect(formatInvocation(RESEARCH, 'cmd')).toMatchObject({
        ok: false,
        reason: 'shell_unrepresentable',
        detail: expect.stringContaining('percent sign') as unknown,
      });
      const out = join(work, 'cmd.json');

      spawnSync(CMD!, ['/d', '/s', '/c', `"${text(RESEARCH_FOR_CMD, 'cmd')}"`], {
        env: { ...launcherEnv(bin), ARGV_ECHO_OUT: out },
        windowsVerbatimArguments: true,
        encoding: 'utf8',
        timeout: 60_000,
      });

      expect(readEcho(out)).toEqual(expected(RESEARCH_FOR_CMD));
    },
    90_000,
  );

  it('marks cmd unavailable, with the reason, for a goal with a line break', () => {
    const result = formatInvocation(MULTILINE, 'cmd');

    expect(result).toMatchObject({ ok: false, reason: 'shell_unrepresentable' });
    expect(formatInvocation(MULTILINE, 'posix').ok).toBe(true);
    expect(formatInvocation(MULTILINE, 'powershell').ok).toBe(true);
  });
});
