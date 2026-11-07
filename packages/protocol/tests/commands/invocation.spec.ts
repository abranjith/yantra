import { describe, expect, it } from 'vitest';

import {
  CommandInvocation,
  createInvocationId,
  isAbsoluteCwd,
  parseInvocation,
  type ParseError,
  type ParsedInvocation,
} from '../../src/commands/index.js';
import { ULID_PATTERN } from '../../src/utils/ulid.js';

const CWD = '/home/user/work';
const ID = '01JAAAAAAAAAAAAAAAAAAAAAAA';

function parsed(argv: readonly string[]): ParsedInvocation {
  const result = parseInvocation(argv, { cwd: CWD, invocationId: ID });
  if (!result.isOk) throw new Error(`expected success: ${JSON.stringify(result.error)}`);
  return result.value;
}

function failure(argv: readonly string[]): ParseError {
  const result = parseInvocation(argv, { cwd: CWD, invocationId: ID });
  if (result.isOk) throw new Error(`expected failure for ${argv.join(' ')}`);
  return result.error;
}

describe('@no-llm parseInvocation: success', () => {
  it('resolves an alias to the canonical path', () => {
    const value = parsed(['discover', 'book a table']);
    expect(value.invocation.path).toEqual(['do']);
    expect(value.entry.id).toBe('do');
    expect(value.arguments).toEqual({ goal: 'book a table' });
    expect(value.invocation.argv).toEqual(['book a table']);
  });

  it('carries the id, the cwd and the tokens after the path', () => {
    const value = parsed(['config', 'get', 'paths.data_dir', '--json']);
    expect(value.invocation).toEqual({
      invocation_id: ID,
      path: ['config', 'get'],
      argv: ['paths.data_dir', '--json'],
      cwd: CWD,
    });
  });

  it('accepts --opt=value, -pvalue and repeatable values', () => {
    const value = parsed(['run', 'wf', '--params=a=1', '-pb=2', '--params', 'c=3']);
    expect(value.options.params).toEqual(['a=1', 'b=2', 'c=3']);
    expect(value.arguments).toEqual({ 'workflow-name': 'wf' });
  });

  it('accumulates repeatable --params a=1 --params b=2', () => {
    expect(parsed(['run', 'wf', '--params', 'a=1', '--params', 'b=2']).options.params).toEqual([
      'a=1',
      'b=2',
    ]);
  });

  it('stops a variadic option at the next option, and keeps swallowing operands until then', () => {
    expect(parsed(['run', '-p', 'a=1', 'b=2', '--json', 'wf']).options.params).toEqual([
      'a=1',
      'b=2',
    ]);
    // Commander's grammar: a positional after a variadic value is another value.
    const swallowed = failure(['run', '-p', 'a=1', 'wf']);
    expect(swallowed.code).toBe('missing_argument');
  });

  it('places options before, between and after positionals', () => {
    const value = parsed(['prefs', '--json', 'set', '--debug', 'k', 'v']);
    expect(value.arguments).toEqual({ action: 'set', key: 'k', value: 'v' });
    expect(value.options).toMatchObject({ json: true, debug: true });
  });

  it('treats tokens after -- as positionals, even with a leading dash', () => {
    const value = parsed(['show', '--', '-weird-name']);
    expect(value.arguments).toEqual({ target: '-weird-name' });
    expect(value.invocation.argv).toEqual(['--', '-weird-name']);
  });

  it('keeps a root-level -- in front of argv so the invocation re-parses identically', () => {
    const value = parsed(['--', 'show', '-x']);
    expect(value.invocation.path).toEqual(['show']);
    expect(value.invocation.argv).toEqual(['--', '-x']);
    expect(value.arguments).toEqual({ target: '-x' });
  });

  it('stores --no-llm as llm: false', () => {
    const value = parsed(['ask', 'q', '--no-llm']);
    expect(value.options.llm).toBe(false);
    expect(value.explicit).toContain('llm');
  });

  it('applies commander defaults without listing them as explicit', () => {
    const value = parsed(['ask', 'q']);
    expect(value.options).toMatchObject({
      json: false,
      format: 'terminal',
      limit: '3',
      llm: true,
      screenshots: true,
      cache: true,
      color: true,
    });
    expect(value.options).not.toHaveProperty('detail');
    expect(value.explicit).toEqual([]);
  });

  it('applies an optional argument default', () => {
    expect(parsed(['list']).arguments).toEqual({ target: 'runs' });
    expect(parsed(['open']).arguments).toEqual({});
  });

  it('lets the last occurrence of a single-valued option win', () => {
    expect(parsed(['list', '--limit', '5', '--limit', '7']).options.limit).toBe('7');
  });

  it('treats a negative number as a positional in a leaf', () => {
    expect(parsed(['show', '-5']).arguments).toEqual({ target: '-5' });
  });

  it('resolves the execution class (prefs set → mutate, doctor --agent-smoke → run)', () => {
    expect(parsed(['prefs', 'set', 'defaults.detail', 'full']).execution).toBe('mutate');
    expect(parsed(['prefs', 'get', 'defaults.detail']).execution).toBe('read');
    expect(parsed(['doctor']).execution).toBe('read');
    expect(parsed(['doctor', '--agent-smoke']).execution).toBe('run');
    expect(parsed(['browser', 'update', '--dry-run']).execution).toBe('read');
  });

  it('accepts Windows and UNC working directories', () => {
    for (const cwd of ['C:\\Users\\me', 'd:/work', '\\\\server\\share']) {
      expect(parseInvocation(['list'], { cwd }).isOk).toBe(true);
    }
  });

  it('generates a ULID when no invocation id is supplied', () => {
    const result = parseInvocation(['list'], { cwd: CWD });
    expect(result.isOk && ULID_PATTERN.test(result.value.invocation.invocation_id)).toBe(true);
  });
});

describe('@no-llm parseInvocation: errors', () => {
  it.each([
    [['nope'], 'unknown_command', 0],
    [['config', 'nope'], 'unknown_command', 1],
    [['help', 'nope'], 'unknown_command', 1],
    [['list', '--nope'], 'unknown_option', 1],
    [['config', 'get', 'k', '--nope'], 'unknown_option', 3],
    [['--json', 'list'], 'unknown_option', 0],
    [['list', '--json=yes'], 'unknown_option', 1],
    [['list', '--limit'], 'missing_option_value', 1],
    [['ask', 'q', '--format', 'yaml'], 'invalid_choice', 3],
    [['ask', 'q', '--format=yaml'], 'invalid_choice', 2],
    [['list', 'a', 'b'], 'too_many_arguments', 2],
  ] as const)('%j fails with %s at token %i', (argv, code, index) => {
    const error = failure(argv);
    expect(error.code).toBe(code);
    expect(error.token_index).toBe(index);
    expect(error.message.length).toBeGreaterThan(0);
  });

  it.each([
    [[], 'group_requires_subcommand'],
    [['config'], 'group_requires_subcommand'],
    [['audit'], 'missing_argument'],
    [['schedule', 'wf'], 'missing_required_option'],
    [['--help'], 'help_or_version'],
    [['list', '-h'], 'help_or_version'],
    [['help'], 'help_or_version'],
    [['help', 'discover'], 'help_or_version'],
    [['config', 'help', 'get'], 'help_or_version'],
    [['-V'], 'help_or_version'],
    [['list', '--limit', '5', '-V'], 'help_or_version'],
  ] as const)('%j fails with %s', (argv, code) => {
    expect(failure(argv).code).toBe(code);
  });

  it('checks help before unknown options, and parse-time errors before help', () => {
    expect(failure(['list', '--nope', '--help']).code).toBe('help_or_version');
    expect(failure(['ask', 'q', '--format', 'yaml', '--help']).code).toBe('invalid_choice');
  });

  it('does not treat --help consumed as an option value as a help request', () => {
    expect(parsed(['list', '--workflow', '--help']).options.workflow).toBe('--help');
  });

  it('suggests a close option or command', () => {
    expect(failure(['list', '--limt', '5']).suggestion).toBe('--limit');
    expect(failure(['lst']).suggestion).toBe('list');
  });

  it('uses commander vocabulary in messages', () => {
    expect(failure(['list', '--nope']).message).toBe("error: unknown option '--nope'");
    expect(failure(['audit']).message).toBe("error: missing required argument 'run-id'");
    expect(failure(['list', 'a', 'b']).message).toBe(
      "error: too many arguments for 'list'. Expected 1 argument but got 2.",
    );
  });

  it('rejects a relative cwd and a malformed invocation id without throwing', () => {
    const relative = parseInvocation(['list'], { cwd: 'work' });
    expect(relative.isOk ? null : relative.error.code).toBe('invalid_invocation');
    const badId = parseInvocation(['list'], { cwd: CWD, invocationId: 'nope' });
    expect(badId.isOk ? null : badId.error.code).toBe('invalid_invocation');
  });
});

describe('@no-llm CommandInvocation', () => {
  it('validates the wire contract strictly', () => {
    const valid = { invocation_id: ID, path: ['list'], argv: [], cwd: CWD };
    expect(CommandInvocation.safeParse(valid).success).toBe(true);
    expect(CommandInvocation.safeParse({ ...valid, path: [] }).success).toBe(false);
    expect(CommandInvocation.safeParse({ ...valid, extra: 1 }).success).toBe(false);
    expect(CommandInvocation.safeParse({ ...valid, cwd: 'relative' }).success).toBe(false);
  });

  it('creates ULID invocation ids', () => {
    expect(createInvocationId()).toMatch(ULID_PATTERN);
    expect(createInvocationId()).not.toBe(createInvocationId());
  });

  it.each([
    ['/', true],
    ['/usr', true],
    ['C:\\', true],
    ['c:/x', true],
    ['\\\\host\\share', true],
    ['', false],
    ['relative/path', false],
    ['C:relative', false],
    ['\\single', false],
  ])('treats %j as absolute: %s', (path, expected) => {
    expect(isAbsoluteCwd(path)).toBe(expected);
  });
});
