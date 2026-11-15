/**
 * Real shells and `yantra` launchers that record their argv (FEAT-062,
 * shared with FEAT-067's CLI-twin suites).
 *
 * The launchers are shaped like the npm/pnpm cmd-shim templates
 * (https://github.com/npm/cmd-shim/blob/main/lib/index.js) and run
 * `argv-echo.mjs`, which writes the argv it received to `$ARGV_ECHO_OUT`.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';

export const IS_WINDOWS = process.platform === 'win32';

/** The argv recorder every launcher runs. */
export const ECHO = resolve(import.meta.dirname, 'argv-echo.mjs');

/** Git Bash on Windows (never WSL's bash.exe), `bash` elsewhere, or null. */
export function findBash(): string | null {
  if (!IS_WINDOWS) {
    const probe = spawnSync('bash', ['-c', 'echo ok'], { encoding: 'utf8' });
    return probe.status === 0 ? 'bash' : null;
  }
  // Git Bash only: System32\bash.exe is WSL, a different machine.
  for (const candidate of [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  const git = spawnSync('where.exe', ['git'], { encoding: 'utf8' });
  for (const line of (git.stdout ?? '').split(/\r?\n/)) {
    const bash = resolve(dirname(line.trim()), '..', 'bin', 'bash.exe');
    if (line.trim() !== '' && existsSync(bash)) return bash;
  }
  return null;
}

/** Windows PowerShell 5.1, or null off Windows. */
export function findPowerShell(): string | null {
  if (!IS_WINDOWS) return null;
  const path = join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  return existsSync(path) ? path : null;
}

/** cmd, or null off Windows. */
export function findCmd(): string | null {
  return IS_WINDOWS ? (process.env.ComSpec ?? 'cmd.exe') : null;
}

/** Writes `yantra` (sh), `yantra.cmd` and `yantra.ps1` launchers into `bin`. */
export function writeLaunchers(bin: string): void {
  const echoPosix = ECHO.replace(/\\/g, '/');
  // cmd-shim's sh template, reduced to the node-on-PATH branch.
  const sh = `#!/bin/sh\nexec node  "${echoPosix}" "$@"\n`;
  writeFileSync(join(bin, 'yantra'), sh);
  chmodSync(join(bin, 'yantra'), 0o755);
  // cmd-shim's cmd template.
  const cmd = [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    'SET "_prog=node"',
    'SET PATHEXT=%PATHEXT:;.JS;=;%',
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "${ECHO}" %*`,
    '',
  ].join('\r\n');
  writeFileSync(join(bin, 'yantra.cmd'), cmd);
  // cmd-shim's pwsh template, reduced to the node-on-PATH branch.
  const ps1 = [
    '#!/usr/bin/env pwsh',
    '$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent',
    '$exe=""',
    'if ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) {',
    '  $exe=".exe"',
    '}',
    '$ret=0',
    'if ($MyInvocation.ExpectingInput) {',
    `  $input | & "node$exe"  "${ECHO}" $args`,
    '} else {',
    `  & "node$exe"  "${ECHO}" $args`,
    '}',
    '$ret=$LASTEXITCODE',
    'exit $ret',
    '',
  ].join('\r\n');
  writeFileSync(join(bin, 'yantra.ps1'), ps1);
}

/** The environment with `bin` and node first on PATH. */
export function launcherEnv(bin: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.toLowerCase() !== 'path') env[key] = value;
  }
  env.PATH = [bin, dirname(process.execPath), process.env.PATH ?? process.env.Path ?? ''].join(
    delimiter,
  );
  return env;
}

/** The argv a launcher recorded at `path`, or `<not run>`. */
export function readEcho(path: string): unknown {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as unknown) : '<not run>';
}
