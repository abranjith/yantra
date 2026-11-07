import { describe, expect, it } from 'vitest';

import {
  CommandRegistryError,
  InputKind,
  OptionSpec,
  PrecedenceStep,
  attributeForLong,
  expandOptions,
  parseOptionFlags,
  validateCommandRegistry,
  type CommandRegistryRule,
} from '../../src/commands/index.js';

import { cloneRegistry, jsonOption, minimalRegistry, noLlmOption } from './factories.js';

type MutableRegistry = ReturnType<typeof cloneRegistry>;

function leaf(registry: MutableRegistry, id: string): Record<string, unknown> {
  const entry = registry.commands.find((command) => command.id === id);
  if (entry === undefined) throw new Error(`no entry ${id}`);
  return entry;
}

function expectRule(
  mutate: (registry: MutableRegistry) => void,
  rule: CommandRegistryRule,
  entryId?: string,
): void {
  const registry = cloneRegistry();
  mutate(registry);
  let caught: unknown;
  try {
    validateCommandRegistry(registry);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(CommandRegistryError);
  const failure = caught as CommandRegistryError;
  expect(failure.rule).toBe(rule);
  if (entryId !== undefined) expect(failure.entryId).toBe(entryId);
}

describe('@no-llm command registry schema', () => {
  it('accepts a minimal valid registry and applies schema defaults', () => {
    const registry = validateCommandRegistry(minimalRegistry());

    const getEntry = registry.commands.find((entry) => entry.id === 'config.get');
    expect(getEntry?.kind).toBe('leaf');
    if (getEntry?.kind !== 'leaf') return;
    expect(getEntry.aliases).toEqual([]);
    expect(getEntry.relations).toEqual([]);
    expect(getEntry.execution.rules).toEqual([]);
    expect(getEntry.arguments[0]?.variadic).toBe(false);
    const json = getEntry.options[0];
    expect(json !== undefined && 'flags' in json ? json.mandatory : null).toBe(false);
  });

  it('does not mutate its input', () => {
    const input = minimalRegistry();
    const before = JSON.stringify(input);
    validateCommandRegistry(input);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('rejects input kinds outside the closed set', () => {
    expect(InputKind.safeParse({ kind: 'colour' }).success).toBe(false);
    expect(InputKind.safeParse({ kind: 'enum', choices: [], enforced_by: 'parser' }).success).toBe(
      false,
    );
    expect(InputKind.safeParse({ kind: 'path', target: 'dir' }).success).toBe(true);
    expect(InputKind.safeParse({ kind: 'number', integer: true, min: 1 }).success).toBe(true);
  });

  it('accepts only variable names for env precedence steps', () => {
    expect(PrecedenceStep.safeParse({ source: 'env', name: 'YANTRA_AGENT_MODEL' }).success).toBe(
      true,
    );
    expect(PrecedenceStep.safeParse({ source: 'env', name: 'value with spaces' }).success).toBe(
      false,
    );
  });

  it('rejects unknown option fields (strict objects)', () => {
    expect(OptionSpec.safeParse({ ...jsonOption(), colour: 'red' }).success).toBe(false);
  });
});

describe('@no-llm validateCommandRegistry rules', () => {
  it('names a schema failure with the offending entry', () => {
    expectRule((r) => (leaf(r, 'doctor').effect = 'everything'), 'schema', 'doctor');
    expectRule((r) => (r.registry_version = 2), 'schema', '<registry>');
  });

  it('rejects a duplicate id', () => {
    expectRule((r) => r.commands.push(structuredClone(leaf(r, 'doctor'))), 'duplicate-id');
  });

  it('rejects an id that differs from its path', () => {
    expectRule((r) => (leaf(r, 'config.get').id = 'config.fetch'), 'id-path-mismatch');
  });

  it('rejects an orphan subcommand without a group', () => {
    expectRule((r) => {
      const entry = leaf(r, 'config.get');
      entry.id = 'cfg.get';
      entry.path = ['cfg', 'get'];
    }, 'orphan-subcommand');
  });

  it('rejects a subcommand whose parent is a leaf', () => {
    expectRule((r) => {
      const child = structuredClone(leaf(r, 'config.get'));
      child.id = 'doctor.get';
      child.path = ['doctor', 'get'];
      r.commands.push(child);
    }, 'orphan-subcommand');
  });

  it('rejects a subcommand listed before its group', () => {
    expectRule((r) => r.commands.reverse(), 'orphan-subcommand');
  });

  it('rejects a group without children', () => {
    expectRule(
      (r) => (r.commands = r.commands.filter((entry) => entry.id !== 'config.get')),
      'empty-group',
      'config',
    );
  });

  it('rejects a duplicate long flag after group expansion', () => {
    expectRule(
      (r) => (leaf(r, 'doctor').options as unknown[]).push(noLlmOption()),
      'duplicate-option',
      'doctor',
    );
  });

  it('rejects a duplicate short flag', () => {
    expectRule((r) => {
      const options = leaf(r, 'config.get').options as unknown[];
      options.push(
        {
          ...jsonOption(),
          flags: '-j, --json-a',
          long: '--json-a',
          short: '-j',
          attribute: 'jsonA',
        },
        {
          ...jsonOption(),
          flags: '-j, --json-b',
          long: '--json-b',
          short: '-j',
          attribute: 'jsonB',
        },
      );
    }, 'duplicate-option');
  });

  it('rejects a leaf without execution', () => {
    expectRule((r) => delete leaf(r, 'doctor').execution, 'missing-execution', 'doctor');
  });

  it('rejects class adapter without adapter details', () => {
    expectRule(
      (r) => (leaf(r, 'doctor').execution = { default: 'adapter' }),
      'adapter-required',
      'doctor',
    );
  });

  it('rejects an adapter class reached only through a rule', () => {
    expectRule(
      (r) =>
        (leaf(r, 'doctor').execution = {
          default: 'read',
          rules: [{ when: { option: '--agent-smoke', present: true }, class: 'adapter' }],
        }),
      'adapter-required',
    );
  });

  it('rejects class exemption without exemption details', () => {
    expectRule(
      (r) => (leaf(r, 'doctor').execution = { default: 'exemption' }),
      'exemption-required',
    );
  });

  it('accepts adapter and exemption classes with their details', () => {
    const registry = cloneRegistry();
    leaf(registry, 'doctor').execution = {
      default: 'adapter',
      adapter: { id: 'daemon-control', executes_as: 'mutate', note: 'test' },
      rules: [{ when: { option: '--agent-smoke', present: true }, class: 'exemption' }],
      exemption: { decision: 'D15', reason: 'test' },
    };
    expect(() => validateCommandRegistry(registry)).not.toThrow();
  });

  it('rejects a condition naming an unknown option', () => {
    expectRule(
      (r) =>
        (leaf(r, 'doctor').execution = {
          default: 'read',
          rules: [{ when: { option: '--nope', present: true }, class: 'run' }],
        }),
      'unknown-condition-target',
    );
  });

  it('rejects a condition naming an unknown argument', () => {
    expectRule(
      (r) =>
        (leaf(r, 'prefs').execution = {
          default: 'read',
          rules: [{ when: { argument: 'verb', in: ['set'] }, class: 'mutate' }],
        }),
      'unknown-condition-target',
    );
  });

  it('checks applicability conditions too, including group options', () => {
    expectRule((r) => {
      const options = leaf(r, 'config.get').options as Record<string, unknown>[];
      options[0]!.applicability = [{ option: '--missing', present: true }];
    }, 'unknown-condition-target');

    const registry = cloneRegistry();
    const options = leaf(registry, 'doctor').options as Record<string, unknown>[];
    options[1]!.applicability = [{ option: '--no-llm', equals: false }];
    expect(() => validateCommandRegistry(registry)).not.toThrow();
  });

  it('rejects a relation naming an unknown option', () => {
    expectRule(
      (r) =>
        (leaf(r, 'doctor').relations = [
          { kind: 'conflicts', option: '--agent-smoke', with: ['--refresh'] },
        ]),
      'unknown-relation-target',
    );
  });

  it('rejects a boolean option with a string default', () => {
    expectRule(
      (r) => ((leaf(r, 'config.get').options as Record<string, unknown>[])[0]!.default = 'yes'),
      'default-type-mismatch',
    );
  });

  it('rejects a repeatable option with a non-array default', () => {
    expectRule((r) => {
      (leaf(r, 'prefs').options as Record<string, unknown>[])[0] = {
        flags: '--allow-host <host>',
        long: '--allow-host',
        attribute: 'allowHost',
        value: 'required',
        repeatable: true,
        description: 'repeatable',
        default: 'example.com',
        input: { kind: 'text' },
      };
    }, 'default-type-mismatch');
  });

  it('rejects an enum default outside its choices', () => {
    expectRule((r) => {
      (leaf(r, 'prefs').options as unknown[]).push({
        flags: '--format <format>',
        long: '--format',
        attribute: 'format',
        value: 'required',
        description: 'output format',
        default: 'yaml',
        input: { kind: 'enum', choices: ['terminal', 'json'], enforced_by: 'parser' },
      });
    }, 'enum-default-outside-choices');
  });

  it('rejects json.flag without a --json option', () => {
    expectRule(
      (r) => (leaf(r, 'doctor').json = { flag: '--json', shape: 'document', schema: null }),
      'json-flag-mismatch',
      'doctor',
    );
  });

  it('rejects a --json option without json.flag', () => {
    expectRule(
      (r) => (leaf(r, 'config.get').json = { flag: null, shape: 'none', schema: null }),
      'json-flag-mismatch',
    );
  });

  it('rejects exit codes missing 0', () => {
    expectRule(
      (r) => (leaf(r, 'doctor').exit_codes = [{ code: 3, meaning: 'environment' }]),
      'exit-codes-missing-zero',
    );
  });

  it('rejects a repeated exit code', () => {
    expectRule(
      (r) =>
        (leaf(r, 'doctor').exit_codes = [
          { code: 0, meaning: 'ok' },
          { code: 0, meaning: 'also ok' },
        ]),
      'duplicate-exit-code',
    );
  });

  it('rejects empty exit codes through the schema', () => {
    expectRule((r) => (leaf(r, 'doctor').exit_codes = []), 'schema', 'doctor');
  });

  it('rejects an alias colliding with a sibling name', () => {
    expectRule((r) => (leaf(r, 'doctor').aliases = ['prefs']), 'alias-collision', 'doctor');
  });

  it('rejects an alias colliding with a sibling alias', () => {
    expectRule((r) => {
      leaf(r, 'doctor').aliases = ['check'];
      leaf(r, 'prefs').aliases = ['check'];
    }, 'alias-collision');
  });

  it('allows the same alias under different parents', () => {
    const registry = cloneRegistry();
    leaf(registry, 'doctor').aliases = ['get'];
    expect(() => validateCommandRegistry(registry)).not.toThrow();
  });

  it('rejects a duplicate option group and an unknown group reference', () => {
    expectRule(
      (r) => r.option_groups.push(structuredClone(r.option_groups[0]!)),
      'duplicate-option-group',
    );
    expectRule(
      (r) => (leaf(r, 'prefs').options as unknown[]).push({ group: 'agent-budget' }),
      'unknown-option-group',
      'prefs',
    );
  });

  it('rejects derived fields that disagree with the flags string', () => {
    expectRule(
      (r) => ((leaf(r, 'config.get').options as Record<string, unknown>[])[0]!.attribute = 'JSON'),
      'flags-mismatch',
    );
    expectRule(
      (r) => ((leaf(r, 'prefs').options as Record<string, unknown>[])[0]!.value = 'optional'),
      'flags-mismatch',
    );
    expectRule(
      (r) => ((r.option_groups[0]!.options as Record<string, unknown>[])[0]!.negatable = false),
      'flags-mismatch',
      'group:no-llm',
    );
  });

  it('rejects a value-taking option declared as a bool input, and a switch that is not', () => {
    expectRule(
      (r) => ((leaf(r, 'prefs').options as Record<string, unknown>[])[0]!.input = { kind: 'bool' }),
      'input-kind-mismatch',
    );
    expectRule(
      (r) =>
        ((leaf(r, 'config.get').options as Record<string, unknown>[])[0]!.input = {
          kind: 'text',
        }),
      'input-kind-mismatch',
    );
  });

  it('rejects a precedence chain that does not start with the flag or ends early', () => {
    expectRule(
      (r) =>
        ((r.option_groups[0]!.options as Record<string, unknown>[])[0]!.precedence = [
          { source: 'env', name: 'LLM_PROVIDER' },
        ]),
      'precedence-shape',
    );
    expectRule(
      (r) =>
        ((leaf(r, 'prefs').options as Record<string, unknown>[])[0]!.precedence = [
          { source: 'flag' },
          { source: 'default', value: 'x' },
          { source: 'preference', key: 'a.b' },
        ]),
      'precedence-shape',
    );
  });

  it('rejects argument order and default violations', () => {
    expectRule(
      (r) =>
        (leaf(r, 'prefs').arguments as unknown[]).push({
          name: 'value',
          description: '',
          required: true,
          input: { kind: 'text' },
        }),
      'argument-order',
    );
    expectRule((r) => {
      const args = leaf(r, 'prefs').arguments as Record<string, unknown>[];
      args[0]!.variadic = true;
    }, 'argument-order');
    expectRule((r) => {
      const args = leaf(r, 'config.get').arguments as Record<string, unknown>[];
      args[0]!.default = 'x';
    }, 'argument-default');
    expectRule(
      (r) =>
        (leaf(r, 'prefs').arguments as unknown[]).push({
          name: 'key',
          description: '',
          required: false,
          input: { kind: 'text' },
        }),
      'duplicate-argument',
    );
  });
});

describe('@no-llm CommandRegistryError', () => {
  it('is an Error subclass naming the entry and rule', () => {
    const error = new CommandRegistryError('config.get', 'duplicate-id', 'id is not unique');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('CommandRegistryError');
    expect(error.entryId).toBe('config.get');
    expect(error.rule).toBe('duplicate-id');
    expect(error.message).toContain('config.get');
    expect(error.message).toContain('duplicate-id');
  });
});

describe('@no-llm option flags grammar', () => {
  it.each([
    [
      '-p, --params <key=value...>',
      {
        long: '--params',
        short: '-p',
        value: 'required',
        variadic: true,
        negatable: false,
        attribute: 'params',
      },
    ],
    [
      '--no-llm',
      { long: '--no-llm', value: 'none', variadic: false, negatable: true, attribute: 'llm' },
    ],
    [
      '--template <name|tag|path>',
      {
        long: '--template',
        value: 'required',
        variadic: false,
        negatable: false,
        attribute: 'template',
      },
    ],
    [
      '--auth-secret <ref>',
      {
        long: '--auth-secret',
        value: 'required',
        variadic: false,
        negatable: false,
        attribute: 'authSecret',
      },
    ],
    [
      '--depth [hops]',
      { long: '--depth', value: 'optional', variadic: false, negatable: false, attribute: 'depth' },
    ],
  ])('parses %s like commander', (flags, expected) => {
    expect(parseOptionFlags(flags)).toEqual(expected);
  });

  it('returns null without a long flag', () => {
    expect(parseOptionFlags('-p <x>')).toBeNull();
  });

  it('derives attributes from long flags', () => {
    expect(attributeForLong('--max-llm-calls')).toBe('maxLlmCalls');
    expect(attributeForLong('--no-screenshots')).toBe('screenshots');
  });
});

describe('@no-llm expandOptions', () => {
  it('expands group references in place, tagging each option with its group', () => {
    const registry = validateCommandRegistry(minimalRegistry());
    const doctor = registry.commands.find((entry) => entry.id === 'doctor');
    if (doctor?.kind !== 'leaf') throw new Error('doctor missing');

    const expanded = expandOptions(doctor, registry.option_groups);

    expect(expanded.map((option) => [option.long, option.group])).toEqual([
      ['--no-llm', 'no-llm'],
      ['--agent-smoke', undefined],
    ]);
  });
});
