import {
  COMMAND_REGISTRY,
  COMMAND_REGISTRY_INPUT,
  validateCommandRegistry,
  type CommandRegistryInput,
} from '@yantra/protocol';
import { describe, expect, it } from 'vitest';

import { buildProgram } from '../../src/program.js';

import { compareRegistryWithTree } from './agreement.js';
import { listCommands } from './walk-tree.js';

const tree = listCommands(buildProgram());

function mutatedRegistry(mutate: (input: CommandRegistryInput) => void) {
  const input = structuredClone(COMMAND_REGISTRY_INPUT);
  mutate(input);
  return validateCommandRegistry(input);
}

function inlineOption(input: CommandRegistryInput, id: string, long: string) {
  const entry = input.commands.find((candidate) => candidate.id === id);
  if (entry?.kind !== 'leaf') throw new Error(`no leaf ${id}`);
  const found = entry.options?.find((ref) => 'long' in ref && ref.long === long);
  if (found === undefined || !('long' in found)) throw new Error(`no ${long} on ${id}`);
  return found;
}

describe('@no-llm registry agrees with the live commander tree', () => {
  it('matches every registry entry field by field, in walk order', () => {
    expect(compareRegistryWithTree(COMMAND_REGISTRY, tree)).toEqual([]);
  });

  it('fails with the entry id and field when a default changes', () => {
    const registry = mutatedRegistry((input) => {
      inlineOption(input, 'list', '--limit').default = '25';
    });

    expect(compareRegistryWithTree(registry, tree)).toEqual([
      'list option --limit default: registry "25" vs live "20"',
    ]);
  });

  it('fails when a description, alias or argument drifts', () => {
    const registry = mutatedRegistry((input) => {
      const show = input.commands.find((entry) => entry.id === 'show');
      if (show?.kind !== 'leaf') throw new Error('show missing');
      show.description = 'Display something';
      show.aliases = ['display'];
      show.arguments = [
        { name: 'target', description: '', required: true, input: { kind: 'text' } },
      ];
    });

    const differences = compareRegistryWithTree(registry, tree);
    expect(differences.some((line) => line.startsWith('show description:'))).toBe(true);
    expect(differences.some((line) => line.startsWith('show aliases:'))).toBe(true);
    expect(differences.some((line) => line.startsWith('show arguments:'))).toBe(true);
  });

  it('fails when parser choices, mandatory or repeatable drift', () => {
    const registry = mutatedRegistry((input) => {
      const type = inlineOption(input, 'usage', '--type');
      type.input = {
        kind: 'enum',
        choices: ['ask', 'research', 'run', 'do'],
        enforced_by: 'parser',
      };
      inlineOption(input, 'usage', '--since').mandatory = true;
      const status = inlineOption(input, 'list', '--status');
      status.repeatable = true;
      status.default = [];
    });

    const differences = compareRegistryWithTree(registry, tree);
    expect(differences).toContain(
      'usage option --type choices: registry ["ask","research","run","do"] vs live undefined',
    );
    expect(differences).toContain('usage option --since mandatory: registry true vs live false');
    expect(differences).toContain('list option --status repeatable: registry true vs live false');
  });

  it('fails when an entry names a path the tree does not have, or is out of order', () => {
    const registry = mutatedRegistry((input) => {
      const report = input.commands.findIndex((entry) => entry.id === 'report');
      const audit = input.commands.findIndex((entry) => entry.id === 'audit');
      [input.commands[report], input.commands[audit]] = [
        input.commands[audit]!,
        input.commands[report]!,
      ];
    });
    expect(compareRegistryWithTree(registry, tree)).toContain(
      'audit order: listed after a later command',
    );
  });
});
