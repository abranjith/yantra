/**
 * `tokenizeCommandLine` is the inverse of `formatInvocation` (FEAT-070
 * TASK-001): every formatted command tokenizes back to `[...path, ...argv]`,
 * and anything that would need a shell to mean something is refused with a
 * closed reason and the index to blame.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  COMMAND_REGISTRY,
  TOKENIZE_REFUSALS,
  formatInvocation,
  parseInvocation,
  tokenizeCommandLine,
  type CommandInvocation,
  type LeafEntry,
  type Shell,
} from '../../src/commands/index.js';

import { leafArgv } from './argv-arbitraries.js';

const ID = '01JAAAAAAAAAAAAAAAAAAAAAAA';
const SHELLS: readonly Shell[] = ['posix', 'powershell', 'cmd'];

const inv = (path: string[], argv: string[]): CommandInvocation =>
  ({ invocation_id: ID, path, argv, cwd: '/work' }) as CommandInvocation;

/** Values that stress quoting, without line breaks (a palette line is one line). */
const TRICKY_CHARS = [
  'a',
  'Z',
  '0',
  ' ',
  '\t',
  '"',
  "'",
  '`',
  '$',
  '%',
  '^',
  '!',
  '&',
  '|',
  '<',
  '>',
  '(',
  ')',
  ';',
  ',',
  '=',
  '*',
  '?',
  '#',
  '~',
  '{',
  '}',
  '[',
  ']',
  '\\',
  '/',
  '@',
  ':',
  '.',
  '-',
  '+',
  'é',
  '東',
];
const trickyValue = fc.oneof(
  fc.string({ unit: fc.constantFrom(...TRICKY_CHARS), minLength: 0, maxLength: 8 }),
  fc.stringMatching(/^[a-z0-9]{1,5}$/),
);

const leaves = COMMAND_REGISTRY.commands.filter(
  (entry): entry is LeafEntry => entry.kind === 'leaf',
);

describe('@no-llm tokenizeCommandLine round-trips formatInvocation', () => {
  it.each(leaves.map((leaf) => [leaf.id, leaf] as const))('%s', (_id, entry) => {
    let cmdSkips = 0;
    fc.assert(
      fc.property(
        leafArgv(entry, COMMAND_REGISTRY.option_groups, { nearValid: false, value: trickyValue }),
        fc.constantFrom(...SHELLS),
        (argv, shell) => {
          const parsed = parseInvocation(argv, { cwd: '/work' });
          fc.pre(parsed.isOk);
          if (!parsed.isOk) return;
          const invocation = parsed.value.invocation;
          const formatted = formatInvocation(invocation, shell);
          if (!formatted.ok) {
            // Skipped only where format itself is unavailable, and that is asserted.
            expect(
              formatted.reason === 'secret_input' ||
                (shell === 'cmd' && formatted.reason === 'shell_unrepresentable'),
            ).toBe(true);
            cmdSkips += 1;
            return;
          }
          const result = tokenizeCommandLine(formatted.text, shell);
          if (
            shell === 'cmd' &&
            !result.ok &&
            result.reason === 'expansion' &&
            /![A-Za-z_][A-Za-z0-9_]*!/u.test(formatted.text)
          ) {
            // DEVIATION (spec §TASK-001): cmd refuses `!NAME!` (delayed expansion),
            // which format does not quote away.
            return;
          }
          expect(result).toEqual({ ok: true, argv: [...invocation.path, ...invocation.argv] });
        },
      ),
      { numRuns: 60 },
    );
    expect(cmdSkips).toBeGreaterThanOrEqual(0);
  });

  it('round-trips the quoting goldens in every shell', () => {
    const values = ['a b', '', "it's", '$HOME', 'a`b', 'a^b', 'wow!', 'a&b', 'café', 'C:\\dir\\'];
    for (const shell of SHELLS) {
      for (const value of values) {
        const formatted = formatInvocation(inv(['show'], [value]), shell);
        if (!formatted.ok) continue;
        expect(tokenizeCommandLine(formatted.text, shell)).toEqual({
          ok: true,
          argv: ['show', value],
        });
      }
    }
  });

  it('skips cmd only when format reports it unavailable', () => {
    const formatted = formatInvocation(inv(['show'], ['50%']), 'cmd');
    expect(formatted).toMatchObject({ ok: false, reason: 'shell_unrepresentable' });
  });
});

describe('@no-llm tokenizeCommandLine refusals', () => {
  it.each([
    ['ls | grep', 'posix', 'shell_operator', 3],
    ['show $HOME', 'posix', 'expansion', 5],
    ['template save *.yaml', 'posix', 'glob', 14],
    ['echo $(x)', 'posix', 'expansion', 5],
    ['a && b', 'posix', 'shell_operator', 2],
    ['show "a$b"', 'posix', 'expansion', 7],
    ['show `x`', 'posix', 'expansion', 5],
    ['show ~/x', 'posix', 'expansion', 5],
    ['list > out', 'posix', 'shell_operator', 5],
    ['list ; rm', 'posix', 'shell_operator', 5],
    ['show a?', 'posix', 'glob', 6],
    ['show [a]', 'posix', 'glob', 5],
    ['ls | grep', 'powershell', 'shell_operator', 3],
    ['show $env:HOME', 'powershell', 'expansion', 5],
    ['show $(x)', 'powershell', 'expansion', 5],
    ['show @(1)', 'powershell', 'expansion', 5],
    ['a ; b', 'powershell', 'shell_operator', 2],
    ['show "a$b"', 'powershell', 'expansion', 7],
    ['show %HOME%', 'cmd', 'expansion', 5],
    ['show !X!', 'cmd', 'expansion', 5],
    ['a & b', 'cmd', 'shell_operator', 2],
    ['a | b', 'cmd', 'shell_operator', 2],
    ['a > b', 'cmd', 'shell_operator', 2],
  ] as const)('%j in %s is %s at %i', (text, shell, reason, at) => {
    expect(tokenizeCommandLine(text, shell)).toEqual({ ok: false, reason, at });
  });

  it.each(SHELLS)('refuses empty and whitespace-only input in %s', (shell) => {
    expect(tokenizeCommandLine('', shell)).toEqual({ ok: false, reason: 'empty', at: 0 });
    expect(tokenizeCommandLine(' \t ', shell)).toEqual({ ok: false, reason: 'empty', at: 0 });
    expect(tokenizeCommandLine('yantra', shell)).toEqual({ ok: false, reason: 'empty', at: 0 });
  });

  it.each(SHELLS)('refuses a line break inside the line in %s', (shell) => {
    expect(tokenizeCommandLine('list\nshow x', shell)).toEqual({
      ok: false,
      reason: 'multiline',
      at: 4,
    });
  });

  it.each(SHELLS)('ignores a trailing line break from a paste in %s', (shell) => {
    expect(tokenizeCommandLine('list --json\r\n', shell)).toEqual({
      ok: true,
      argv: ['list', '--json'],
    });
  });

  it.each([
    ["show 'abc", 'posix', 5],
    ['show "abc', 'posix', 5],
    ["show 'abc", 'powershell', 5],
    ['show "abc', 'powershell', 5],
    ['show "abc', 'cmd', 5],
  ] as const)('points an unterminated quote at its opening: %j in %s', (text, shell, at) => {
    expect(tokenizeCommandLine(text, shell)).toEqual({
      ok: false,
      reason: 'unterminated_quote',
      at,
    });
  });

  it('has a closed refusal list', () => {
    expect(TOKENIZE_REFUSALS).toEqual([
      'empty',
      'unterminated_quote',
      'shell_operator',
      'expansion',
      'glob',
      'multiline',
    ]);
  });
});

describe('@no-llm tokenizeCommandLine accepted syntax', () => {
  it('strips one leading yantra only', () => {
    expect(tokenizeCommandLine('yantra list', 'posix')).toEqual({ ok: true, argv: ['list'] });
    expect(tokenizeCommandLine('yantra yantra', 'posix')).toEqual({ ok: true, argv: ['yantra'] });
    expect(tokenizeCommandLine('list yantra', 'posix')).toEqual({
      ok: true,
      argv: ['list', 'yantra'],
    });
  });

  it.each(SHELLS)('handles mixed spaces and tabs in %s', (shell) => {
    expect(tokenizeCommandLine('  sites\t add \t example.com  ', shell)).toEqual({
      ok: true,
      argv: ['sites', 'add', 'example.com'],
    });
  });

  it('reads POSIX quoting and escapes', () => {
    expect(tokenizeCommandLine(`ask "say \\"hi\\" \\$5" it\\'s 'a b'`, 'posix')).toEqual({
      ok: true,
      argv: ['ask', 'say "hi" $5', "it's", 'a b'],
    });
  });

  it('reads PowerShell single and double quotes', () => {
    expect(tokenizeCommandLine(`ask 'it''s' "a\`$b c"`, 'powershell')).toEqual({
      ok: true,
      argv: ['ask', "it's", 'a$b c'],
    });
    // PowerShell 5.1 passes an embedded bare quote through, and the child's parse eats it.
    expect(tokenizeCommandLine(`ask "a\`"b"`, 'powershell')).toEqual({
      ok: true,
      argv: ['ask', 'ab'],
    });
  });

  it('reads cmd quotes and caret escapes', () => {
    expect(tokenizeCommandLine('ask "a & b" x^&y', 'cmd')).toEqual({
      ok: true,
      argv: ['ask', 'a & b', 'x&y'],
    });
  });

  it('keeps unicode', () => {
    expect(tokenizeCommandLine("ask '東京 café'", 'posix')).toEqual({
      ok: true,
      argv: ['ask', '東京 café'],
    });
  });
});
