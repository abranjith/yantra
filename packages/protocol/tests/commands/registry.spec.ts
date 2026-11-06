import { describe, expect, it } from 'vitest';

import {
  COMMAND_REGISTRY,
  COMMAND_REGISTRY_INPUT,
  LEAF_COMMAND_IDS,
  OPTION_GROUP_INPUTS,
  executionClassFor,
  expandOptions,
  findCommand,
  findLeaf,
  validateCommandRegistry,
} from '../../src/commands/index.js';

/** Plan §6: commands the host serves in-process. */
const READ_PLAN = [
  'list',
  'show',
  'audit',
  'report',
  'usage',
  'schedules',
  'profile',
  'config.path',
  'config.list',
  'config.get',
  'config.validate',
  'model.list',
  'sites.list',
  'template.list',
  'template.show',
  'daemon.status',
  'browser.list',
] as const;

describe('@no-llm shipped command registry', () => {
  it('passes every registry rule', () => {
    expect(() => validateCommandRegistry(COMMAND_REGISTRY_INPUT)).not.toThrow();
  });

  it('parses to the same registry the module exports', () => {
    expect(validateCommandRegistry(COMMAND_REGISTRY_INPUT)).toEqual(COMMAND_REGISTRY);
  });

  it('names every leaf id exactly once', () => {
    const leaves = COMMAND_REGISTRY.commands.filter((entry) => entry.kind === 'leaf');
    expect(LEAF_COMMAND_IDS).toEqual(leaves.map((entry) => entry.id));
    expect(new Set(LEAF_COMMAND_IDS).size).toBe(LEAF_COMMAND_IDS.length);
  });

  it('defines all six option groups, in the registrars order', () => {
    expect(OPTION_GROUP_INPUTS.map((group) => group.id)).toEqual([
      'agent-model',
      'agent-budget',
      'agent-turn',
      'no-llm',
      'screenshots',
      'browser-selection',
    ]);
    const flags = OPTION_GROUP_INPUTS.map((group) =>
      group.options.map((option) => option.long).join(' '),
    );
    expect(flags).toEqual([
      '--provider --model --thinking --auth-secret',
      '--max-duration --max-tokens --tool-timeout --tool-retries --confirm-timeout',
      '--turn-timeout',
      '--no-llm',
      '--no-screenshots',
      '--browser --browser-path',
    ]);
  });

  it.each(READ_PLAN)('resolves %s to read with no options', (id) => {
    const entry = findLeaf(id.split('.'));
    expect(entry).toBeDefined();
    expect(executionClassFor(entry!, { options: {}, arguments: {}, explicit: [] })).toBe('read');
  });

  it('resolves doctor to read, and to run with --agent-smoke', () => {
    const doctor = findLeaf(['doctor'])!;
    expect(executionClassFor(doctor, { options: {}, arguments: {}, explicit: [] })).toBe('read');
    expect(
      executionClassFor(doctor, {
        options: { agentSmoke: true },
        arguments: {},
        explicit: ['agentSmoke'],
      }),
    ).toBe('run');
  });

  it('gives doctor the agent-model and no-llm groups, but no budget flags', () => {
    const doctor = findLeaf(['doctor'])!;
    const longs = expandOptions(doctor, COMMAND_REGISTRY.option_groups).map((o) => o.long);
    expect(longs).toContain('--model');
    expect(longs).toContain('--no-llm');
    expect(longs).not.toContain('--max-duration');
    expect(longs).not.toContain('--no-screenshots');
  });

  it('keeps every group immediately before its subcommands', () => {
    const ids = COMMAND_REGISTRY.commands.map((entry) => entry.id);
    for (const entry of COMMAND_REGISTRY.commands) {
      if (entry.path.length < 2) continue;
      const parentIndex = ids.indexOf(entry.path.slice(0, -1).join('.'));
      const between = ids.slice(parentIndex + 1, ids.indexOf(entry.id));
      expect(between.every((id) => id.startsWith(`${entry.path[0]!}.`))).toBe(true);
    }
  });
});

describe('@no-llm findCommand', () => {
  it('finds groups and leaves by canonical path', () => {
    expect(findCommand(['config'])?.kind).toBe('group');
    expect(findCommand(['config', 'get'])?.id).toBe('config.get');
    expect(findLeaf(['config'])).toBeUndefined();
  });

  it('returns undefined for unknown or overlong paths', () => {
    expect(findCommand(['nope'])).toBeUndefined();
    expect(findCommand(['config', 'nope'])).toBeUndefined();
    expect(findCommand(['list', 'runs'])).toBeUndefined();
    expect(findCommand([])).toBeUndefined();
  });
});
