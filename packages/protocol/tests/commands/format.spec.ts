import { describe, expect, it } from 'vitest';

import {
  defaultShellFor,
  formatInvocation,
  quoteCmd,
  quotePosix,
  quotePowerShell,
  type CommandInvocation,
} from '../../src/commands/index.js';

import { tokenizeCmd, tokenizePosix, tokenizePowerShell } from './shell-tokenizers.js';

const ID = '01JAAAAAAAAAAAAAAAAAAAAAAA';

function invocation(path: string[], argv: string[]): CommandInvocation {
  return { invocation_id: ID, path, argv, cwd: '/work' } as CommandInvocation;
}

describe('@no-llm defaultShellFor', () => {
  it('uses PowerShell on Windows and POSIX elsewhere', () => {
    expect(defaultShellFor('win32')).toBe('powershell');
    expect(defaultShellFor('linux')).toBe('posix');
    expect(defaultShellFor('darwin')).toBe('posix');
  });
});

describe('@no-llm per-shell quoting goldens', () => {
  it.each([
    ['plain', 'plain', 'plain', 'plain'],
    ['--json', '--json', '--json', '--json'],
    ['a b', "'a b'", `'"a b"'`, '"a b"'],
    ['', "''", `'""'`, '""'],
    ["it's", `'it'\\''s'`, `'"it''s"'`, "it's"],
    ['say "hi"', `'say "hi"'`, `'"say \\"hi\\""'`, null],
    ['$HOME', "'$HOME'", `'"$HOME"'`, '$HOME'],
    ['a`b', "'a`b'", `'"a\`b"'`, 'a`b'],
    ['50%', '50%', `'"50%"'`, null],
    ['a^b', "'a^b'", `'"a^b"'`, '"a^b"'],
    ['wow!', "'wow!'", `'"wow!"'`, 'wow!'],
    ['a&b', "'a&b'", `'"a&b"'`, '"a&b"'],
    ['line\nbreak', "'line\nbreak'", `'"line\nbreak"'`, null],
    ['-x', '-x', '-x', '-x'],
    ['--', '--', `'"--"'`, '--'],
    ['@file', '@file', `'"@file"'`, '@file'],
    ['a,b', 'a,b', `'"a,b"'`, '"a,b"'],
    ['k=v', 'k=v', 'k=v', '"k=v"'],
    ['café', "'café'", `'"café"'`, 'café'],
    ['東京', "'東京'", `'"東京"'`, '東京'],
    ['C:\\dir\\', "'C:\\dir\\'", `'"C:\\dir\\\\"'`, 'C:\\dir\\'],
    ['a b\\', "'a b\\'", `'"a b\\\\"'`, '"a b\\\\"'],
  ])('quotes %j', (value, posix, powershell, cmd) => {
    expect(quotePosix(value)).toBe(posix);
    expect(quotePowerShell(value)).toBe(powershell);
    if (cmd !== null) expect(quoteCmd(value)).toBe(cmd);
    // Each rendering hands the program the original value back.
    expect(tokenizePosix(`yantra ${posix}`).slice(1)).toEqual([value]);
    expect(tokenizePowerShell(`yantra ${powershell}`).slice(1)).toEqual([value]);
    if (cmd !== null) expect(tokenizeCmd(`yantra ${cmd}`).slice(1)).toEqual([value]);
  });
});

describe('@no-llm formatInvocation', () => {
  it('renders program, canonical path and argv', () => {
    const value = invocation(['do'], ['book a table', '--json']);
    expect(formatInvocation(value, 'posix')).toEqual({
      ok: true,
      text: "yantra do 'book a table' --json",
    });
    expect(formatInvocation(value, 'powershell')).toEqual({
      ok: true,
      text: `yantra do '"book a table"' --json`,
    });
    expect(formatInvocation(value, 'cmd')).toEqual({
      ok: true,
      text: 'yantra do "book a table" --json',
    });
  });

  it('quotes a program path with spaces, using the PowerShell call operator', () => {
    const value = invocation(['list'], []);
    const program = 'C:\\Program Files\\yantra\\yantra.cmd';
    expect(formatInvocation(value, 'powershell', { program })).toEqual({
      ok: true,
      text: "& 'C:\\Program Files\\yantra\\yantra.cmd' list",
    });
    expect(formatInvocation(value, 'cmd', { program })).toEqual({
      ok: true,
      text: '"C:\\Program Files\\yantra\\yantra.cmd" list',
    });
    expect(formatInvocation(value, 'posix', { program: '/opt/my apps/yantra' })).toEqual({
      ok: true,
      text: "'/opt/my apps/yantra' list",
    });
  });

  it('accepts a multi-token program', () => {
    const value = invocation(['list'], ['--json']);
    expect(formatInvocation(value, 'posix', { program: ['node', '/abs/bin.js'] })).toEqual({
      ok: true,
      text: 'node /abs/bin.js list --json',
    });
  });

  it.each([
    ['line\nbreak', 'a line break'],
    ['carriage\rreturn', 'a line break'],
    ['say "hi"', 'a double quote'],
    ['50%', 'a percent sign'],
    ['bell\u0007', 'a control character'],
  ])('marks cmd unavailable for %j, naming the reason', (value, reason) => {
    const result = formatInvocation(invocation(['show'], [value]), 'cmd');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('shell_unrepresentable');
    expect(result.detail).toContain('argument 2');
    expect(result.detail).toContain(reason);
  });

  it('marks cmd unavailable for a program path it cannot carry', () => {
    const result = formatInvocation(invocation(['list'], []), 'cmd', {
      program: 'C:\\100%\\yantra',
    });
    expect(result).toMatchObject({ ok: false, reason: 'shell_unrepresentable' });
    expect(result.ok ? '' : result.detail).toContain('the program path');
  });

  it('refuses to render a secret value in every shell', () => {
    const value = invocation(['secret', 'set'], ['anthropic', 'sk-live-123']);
    for (const shell of ['posix', 'powershell', 'cmd'] as const) {
      const result = formatInvocation(value, shell);
      expect(result).toMatchObject({ ok: false, reason: 'secret_input' });
      expect(JSON.stringify(result)).not.toContain('sk-live-123');
    }
  });

  it('renders secret set without a value (the CLI prompts for it)', () => {
    expect(formatInvocation(invocation(['secret', 'set'], ['anthropic']), 'posix')).toEqual({
      ok: true,
      text: 'yantra secret set anthropic',
    });
  });

  it('refuses a secret command whose argv does not parse, rather than guessing', () => {
    const value = invocation(['secret', 'set'], ['k', 'v', '--bogus']);
    expect(formatInvocation(value, 'posix')).toMatchObject({ ok: false, reason: 'secret_input' });
  });
});
