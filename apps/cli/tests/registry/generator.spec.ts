import {
  CommandRegistryError,
  validateCommandRegistry,
  type CommandRegistryInput,
} from '@yantra/protocol';
import { Command, Option } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import {
  buildCommandTree,
  collect,
  createRegisteredCommand,
  type HandlerTable,
} from '../../src/registry/build-command-tree.js';
import { LEGACY_ONLY, handler } from '../../src/registry/handler.js';
import type { UnmigratedCommand } from '../../src/registry/unmigrated.js';

import { runCase } from './surface.js';

const NONE = { level: 'none' } as const;
const OK = [{ code: 0, meaning: 'success' }] as [{ code: 0; meaning: string }];
const NO_JSON = { flag: null, shape: 'none', schema: null } as const;

function testRegistry(): CommandRegistryInput {
  return {
    registry_version: 1,
    program: { name: 'yantra', description: 'test' },
    option_groups: [
      {
        id: 'no-llm',
        options: [
          {
            flags: '--no-llm',
            long: '--no-llm',
            attribute: 'llm',
            value: 'none',
            negatable: true,
            description: 'force the deterministic no-model path',
            input: { kind: 'bool' },
          },
        ],
      },
    ],
    commands: [
      {
        kind: 'leaf',
        id: 'alpha',
        path: ['alpha'],
        description: 'Alpha leaf',
        help_after: '\nAfter text.\n',
        registration: 'subcommand',
        aliases: ['a'],
        arguments: [
          { name: 'thing', description: 'the thing', required: true, input: { kind: 'text' } },
          {
            name: 'mode',
            description: 'the mode',
            required: false,
            default: 'fast',
            input: { kind: 'text' },
          },
        ],
        options: [
          { group: 'no-llm' },
          {
            flags: '--format <format>',
            long: '--format',
            attribute: 'format',
            value: 'required',
            description: 'output format',
            default: 'terminal',
            input: { kind: 'enum', choices: ['terminal', 'json'], enforced_by: 'parser' },
          },
          {
            flags: '--tier <tier>',
            long: '--tier',
            attribute: 'tier',
            value: 'required',
            description: 'checked by the handler',
            input: { kind: 'enum', choices: ['a', 'b'], enforced_by: 'handler' },
          },
          {
            flags: '-p, --params <key=value...>',
            long: '--params',
            short: '-p',
            attribute: 'params',
            value: 'required',
            variadic: true,
            repeatable: true,
            description: 'parameter',
            default: [],
            input: { kind: 'text' },
          },
          {
            flags: '--cron <expr>',
            long: '--cron',
            attribute: 'cron',
            value: 'required',
            mandatory: true,
            description: 'cron expression',
            input: { kind: 'text' },
          },
        ],
        execution: { default: 'read' },
        effect: 'none',
        danger: NONE,
        exit_codes: OK,
        json: NO_JSON,
      },
      {
        kind: 'group',
        id: 'beta',
        path: ['beta'],
        description: 'Beta group',
        registration: 'added',
      },
      {
        kind: 'leaf',
        id: 'beta.gamma',
        path: ['beta', 'gamma'],
        description: '',
        registration: 'subcommand',
        arguments: [{ name: 'key', description: '', required: true, input: { kind: 'text' } }],
        options: [
          {
            flags: '--json',
            long: '--json',
            attribute: 'json',
            value: 'none',
            description: 'emit JSON',
            default: false,
            input: { kind: 'bool' },
          },
        ],
        execution: { default: 'read' },
        effect: 'none',
        danger: NONE,
        exit_codes: OK,
        json: { flag: '--json', shape: 'envelope', schema: null },
      },
    ],
  };
}

const registry = validateCommandRegistry(testRegistry());
const ASK_UNMIGRATED: readonly UnmigratedCommand[] = [
  { path: 'ask', since: '2026-11-05', reason: 'test', owner: 'FEAT-070' },
];
const noop = (): void => undefined;
const stubs: HandlerTable = { alpha: noop, 'beta.gamma': noop };

function root(): Command {
  return new Command().name('yantra').description('test').showHelpAfterError();
}

function generated(handlers: HandlerTable = stubs): Command {
  return buildCommandTree(root(), registry, handlers);
}

/** The same tree, written the way the CLI's commands were written by hand. */
function handBuilt(): Command {
  const program = root();
  program
    .command('alpha')
    .alias('a')
    .description('Alpha leaf')
    .argument('<thing>', 'the thing')
    .argument('[mode]', 'the mode', 'fast')
    .addOption(new Option('--no-llm', 'force the deterministic no-model path'))
    .addOption(
      new Option('--format <format>', 'output format')
        .choices(['terminal', 'json'])
        .default('terminal'),
    )
    .addOption(new Option('--tier <tier>', 'checked by the handler'))
    .option('-p, --params <key=value...>', 'parameter', collect, [] as string[])
    .requiredOption('--cron <expr>', 'cron expression')
    .addHelpText('after', '\nAfter text.\n')
    .action(noop);
  const beta = new Command('beta').description('Beta group');
  beta.command('gamma').argument('<key>').option('--json', 'emit JSON', false).action(noop);
  program.addCommand(beta);
  return program;
}

const CASES: readonly (readonly string[])[] = [
  ['--help'],
  ['alpha', '--help'],
  ['a', '--help'],
  ['help', 'alpha'],
  ['beta', '--help'],
  ['beta', 'gamma', '--help'],
  ['beta'],
  ['alpha', '--nope', '--cron', 'x'],
  ['alpha', 'x', '--format', 'yaml', '--cron', 'x'],
  ['alpha', 'x'],
  ['alpha', '--cron', 'x'],
  ['beta', 'gamma', '--nope'],
  ['beta', 'gamma', 'k', 'extra'],
];

describe('@no-llm commander generator', () => {
  it.each(CASES)('matches a hand-built tree for %j', async (...argv) => {
    for (const width of [80, 160]) {
      const expected = await runCase(handBuilt, argv, width);
      const actual = await runCase(() => generated(), argv, width);
      expect(actual).toEqual(expected);
    }
  });

  it('shows help after an error only for subcommand-registered commands', async () => {
    const alpha = await runCase(() => generated(), ['alpha', '--nope', '--cron', 'x'], 80);
    const gamma = await runCase(() => generated(), ['beta', 'gamma', '--nope'], 80);
    expect(alpha.stderr).toContain('Usage: yantra alpha|a');
    expect(gamma.stderr).toBe("error: unknown option '--nope'\n");
  });

  it('binds handlers by path with positional args, parsed options and the command', async () => {
    const alpha = vi.fn();
    const program = generated({ alpha: handler(alpha), 'beta.gamma': noop }).exitOverride();

    await program.parseAsync(
      ['a', 'x', '-p', 'k=1', '--params', 'k=2', '--cron', '* * *', '--no-llm'],
      {
        from: 'user',
      },
    );

    expect(alpha).toHaveBeenCalledTimes(1);
    const [args, options, command] = alpha.mock.calls[0] as [unknown[], unknown, Command];
    expect(args).toEqual(['x', 'fast']);
    expect(options).toEqual({
      llm: false,
      format: 'terminal',
      params: ['k=1', 'k=2'],
      cron: '* * *',
    });
    expect(command.name()).toBe('alpha');
  });

  it('awaits async handlers', async () => {
    const order: string[] = [];
    const program = generated({
      alpha: async () => {
        await Promise.resolve();
        order.push('handler');
      },
      'beta.gamma': noop,
    });
    await program.parseAsync(['alpha', 'x', '--cron', 'c'], { from: 'user' });
    order.push('after');
    expect(order).toEqual(['handler', 'after']);
  });

  it('throws CommandRegistryError when a generated leaf has no handler', () => {
    expect(() => generated({ alpha: noop })).toThrow(CommandRegistryError);
    try {
      generated({ alpha: noop });
    } catch (error) {
      expect((error as CommandRegistryError).entryId).toBe('beta.gamma');
      expect((error as CommandRegistryError).rule).toBe('missing-handler');
    }
  });

  it('throws when a generated leaf is bound to the legacy-only marker', () => {
    expect(() => generated({ alpha: LEGACY_ONLY, 'beta.gamma': noop })).toThrow(/legacy-only/);
  });

  it('accumulates repeatable values with collect', () => {
    expect(collect('b', ['a'])).toEqual(['a', 'b']);
    expect(collect('a', [])).toEqual(['a']);
  });
});

describe('@no-llm buildCommandTree ordering and legacy families', () => {
  it('follows the legacy order and calls the factory of an unmigrated family', () => {
    const register = vi.fn((program: Command) => {
      program.addCommand(new Command('ask').description('legacy ask'));
    });
    const program = buildCommandTree(
      root(),
      registry,
      stubs,
      [{ name: 'beta' }, { name: 'ask', register }, { name: 'alpha' }],
      ASK_UNMIGRATED,
    );
    expect(register).toHaveBeenCalledTimes(1);
    expect(program.commands.map((command) => command.name())).toEqual(['beta', 'ask', 'alpha']);
  });

  it('rejects an unmigrated family without a factory', () => {
    expect(() =>
      buildCommandTree(
        root(),
        registry,
        stubs,
        [{ name: 'beta' }, { name: 'alpha' }, { name: 'ask' }],
        ASK_UNMIGRATED,
      ),
    ).toThrow(/unmigrated but has no factory/);
  });

  it('rejects a migrated family with no registry entry', () => {
    expect(() =>
      buildCommandTree(root(), registry, stubs, [
        { name: 'alpha' },
        { name: 'beta' },
        { name: 'list' },
      ]),
    ).toThrow(/migrated but has no entry/);
  });

  it('rejects a registry family missing from the legacy order', () => {
    expect(() => buildCommandTree(root(), registry, stubs, [{ name: 'alpha' }])).toThrow(
      /no place in root order/,
    );
  });

  it('uses registry order when no legacy list is given', () => {
    expect(generated().commands.map((command) => command.name())).toEqual(['alpha', 'beta']);
  });
});

describe('@no-llm createRegisteredCommand', () => {
  it('builds a detached command for an added entry', () => {
    const beta = createRegisteredCommand('beta', stubs, registry);
    expect(beta.parent).toBeNull();
    expect(beta.commands.map((command) => command.name())).toEqual(['gamma']);
  });

  it('refuses subcommand-registered and unknown entries', () => {
    expect(() => createRegisteredCommand('alpha', stubs, registry)).toThrow(CommandRegistryError);
    expect(() => createRegisteredCommand('nope', stubs, registry)).toThrow(CommandRegistryError);
  });
});
