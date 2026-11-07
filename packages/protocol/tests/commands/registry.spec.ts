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

describe('@no-llm run-class entries', () => {
  const facts = { options: {}, arguments: {}, explicit: [] };

  it.each(['ask', 'research', 'do', 'run', 'resume'])('resolves %s to run', (id) => {
    expect(executionClassFor(findLeaf([id])!, facts)).toBe('run');
  });

  it('records the --json result shape of each run-class command', () => {
    expect(findLeaf(['ask'])!.json).toEqual({ flag: '--json', shape: 'document', schema: 'Brief' });
    expect(findLeaf(['research'])!.json.schema).toBe('Brief');
    expect(findLeaf(['do'])!.json).toEqual({
      flag: '--json',
      shape: 'ndjson',
      schema: 'TaskEvent',
    });
    expect(findLeaf(['run'])!.json).toEqual({ flag: '--json', shape: 'envelope', schema: null });
    expect(findLeaf(['resume'])!.json.shape).toBe('envelope');
  });

  it('marks resume --force as needing confirmation', () => {
    const resume = findLeaf(['resume'])!;
    const force = expandOptions(resume, COMMAND_REGISTRY.option_groups).find(
      (option) => option.long === '--force',
    );
    expect(force?.danger?.level).toBe('confirm');
  });

  it('composes do from the groups in registration order, then its own options', () => {
    const doEntry = findLeaf(['discover'])!;
    expect(doEntry.id).toBe('do');
    expect(doEntry.options.slice(0, 6)).toEqual([
      { group: 'agent-model' },
      { group: 'agent-budget' },
      { group: 'no-llm' },
      { group: 'screenshots' },
      { group: 'agent-turn' },
      { group: 'browser-selection' },
    ]);
  });

  it('applies --detail only to terminal output and budgets only on the LLM path', () => {
    const ask = findLeaf(['ask'])!;
    const options = expandOptions(ask, COMMAND_REGISTRY.option_groups);
    expect(options.find((o) => o.long === '--detail')?.applicability).toEqual([
      { option: '--format', equals: 'terminal' },
    ]);
    expect(options.find((o) => o.long === '--max-tokens')?.applicability).toEqual([
      { mode: 'llm' },
    ]);
  });

  it('declares the browser-path relation on every command with the browser group', () => {
    for (const entry of COMMAND_REGISTRY.commands) {
      if (entry.kind !== 'leaf') continue;
      const hasGroup = entry.options.some(
        (ref) => 'group' in ref && ref.group === 'browser-selection',
      );
      const hasRelation = entry.relations.some((relation) => relation.option === '--browser-path');
      expect({ id: entry.id, hasRelation }).toEqual({ id: entry.id, hasRelation: hasGroup });
    }
  });
});

describe('@no-llm settings entries', () => {
  const prefs = findLeaf(['prefs'])!;
  const classOf = (args: Record<string, string>, options: Record<string, unknown> = {}) =>
    executionClassFor(prefs, { options, arguments: args, explicit: Object.keys(options) });

  it.each([
    [{ action: 'set', key: 'defaults.detail', value: 'full' }, 'mutate'],
    [{ action: 'approve', key: 'defaults.detail' }, 'mutate'],
    [{ action: 'get', key: 'defaults.detail' }, 'read'],
    [{ action: 'list' }, 'read'],
    [{}, 'read'],
  ] as const)('classifies prefs %j as %s', (args, expected) => {
    expect(classOf(args)).toBe(expected);
  });

  it('classifies prefs --forget as mutate whatever the action', () => {
    expect(classOf({}, { forget: 'defaults.detail' })).toBe('mutate');
    expect(classOf({ action: 'list' }, { forget: 'defaults.detail' })).toBe('mutate');
  });

  it('keeps every secret command in-process and never renders a value', () => {
    for (const id of ['set', 'list', 'rm']) {
      expect(findLeaf(['secret', id])!.execution.default).toBe('in-process-secure');
    }
    expect(findLeaf(['secret', 'set'])!.arguments[1]?.input).toEqual({ kind: 'secret-input' });
  });

  it('routes config edit and init through adapters, and config data-dir through D15', () => {
    expect(findLeaf(['config', 'edit'])!.execution.adapter?.id).toBe('config-edit-yaml');
    const init = findLeaf(['init'])!.execution;
    expect(init.adapter).toMatchObject({ id: 'init-onboarding', executes_as: 'mutate' });
    const dataDir = findLeaf(['config', 'data-dir'])!;
    expect(dataDir.execution.default).toBe('exemption');
    expect(dataDir.execution.exemption?.decision).toBe('D15');
    expect(dataDir.danger.level).toBe('confirm');
  });

  it('makes model add --provider mandatory', () => {
    const add = findLeaf(['model', 'add'])!;
    const provider = expandOptions(add, COMMAND_REGISTRY.option_groups).find(
      (option) => option.long === '--provider',
    );
    expect(provider?.mandatory).toBe(true);
  });
});

describe('@no-llm remaining families', () => {
  it('classifies browser update as exclusive, and read with --dry-run', () => {
    const update = findLeaf(['browser', 'update'])!;
    expect(executionClassFor(update, { options: {}, arguments: {}, explicit: [] })).toBe(
      'exclusive',
    );
    expect(
      executionClassFor(update, {
        options: { dryRun: true },
        arguments: {},
        explicit: ['dryRun'],
      }),
    ).toBe('read');
    expect(update.relations).toContainEqual(
      expect.objectContaining({ kind: 'conflicts', option: '--dry-run', with: ['--yes'] }),
    );
  });

  it.each([
    ['browser.install', 'exclusive'],
    ['browser.check', 'run'],
    ['browser.use', 'mutate'],
    ['template.new', 'mutate'],
    ['template.remove', 'mutate'],
    ['lint', 'mutate'],
    ['schedule', 'mutate'],
    ['unschedule', 'mutate'],
    ['confirm', 'mutate'],
    ['open', 'adapter'],
    ['daemon.start', 'adapter'],
    ['daemon.stop', 'adapter'],
  ])('classifies %s as %s by default', (id, expected) => {
    expect(findLeaf(id.split('.'))!.execution.default).toBe(expected);
  });

  it('routes confirm, open and the daemon through their adapters', () => {
    expect(findLeaf(['confirm'])!.execution.adapter).toMatchObject({
      id: 'confirm-inbox',
      executes_as: 'mutate',
    });
    expect(findLeaf(['open'])!.execution.adapter?.id).toBe('open-result-view');
    expect(findLeaf(['daemon', 'stop'])!.execution.adapter).toMatchObject({
      id: 'daemon-control',
      executes_as: 'mutate',
    });
    expect(findLeaf(['daemon', 'stop'])!.danger.level).toBe('confirm');
  });

  it('makes schedule --cron mandatory and --params repeatable with an empty default', () => {
    const options = expandOptions(findLeaf(['schedule'])!, COMMAND_REGISTRY.option_groups);
    expect(options.find((o) => o.long === '--cron')?.mandatory).toBe(true);
    expect(options.find((o) => o.long === '--params')).toMatchObject({
      repeatable: true,
      default: [],
    });
  });

  it('covers all 59 command paths: 7 groups and 52 leaves', () => {
    expect(COMMAND_REGISTRY.commands).toHaveLength(59);
    expect(COMMAND_REGISTRY.commands.filter((entry) => entry.kind === 'group')).toHaveLength(7);
  });
});

describe('@no-llm registry integrity: lexical danger guard', () => {
  const DANGEROUS_LEAVES = new Set(['rm', 'remove', 'unset', 'unschedule', 'stop']);
  const DANGEROUS_OPTIONS = new Set(['--force', '--reset', '--forget']);
  /** `<entry id>` or `<entry id> <long>` → why it may skip confirmation. None today. */
  const EXCEPTIONS: Readonly<Record<string, string>> = {};

  it('requires confirmation for every removal, stop, --force, --reset and --forget', () => {
    const missing: string[] = [];
    for (const entry of COMMAND_REGISTRY.commands) {
      if (entry.kind !== 'leaf') continue;
      if (
        DANGEROUS_LEAVES.has(entry.path.at(-1)!) &&
        entry.danger.level !== 'confirm' &&
        !(entry.id in EXCEPTIONS)
      ) {
        missing.push(entry.id);
      }
      for (const option of expandOptions(entry, COMMAND_REGISTRY.option_groups)) {
        const key = `${entry.id} ${option.long}`;
        if (
          DANGEROUS_OPTIONS.has(option.long) &&
          option.danger?.level !== 'confirm' &&
          !(key in EXCEPTIONS)
        ) {
          missing.push(key);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('keeps every exception justified in writing', () => {
    for (const reason of Object.values(EXCEPTIONS)) expect(reason.trim().length).toBeGreaterThan(0);
  });
});

describe('@no-llm registry integrity: group spelling', () => {
  /**
   * Inline options that share a group's long flag on purpose. Each is a
   * different idea under the same word, not a re-spelling of the group option.
   */
  const SPELLING_EXCEPTIONS: Readonly<Record<string, string>> = {
    'init --provider':
      "selects the installation's default provider from a closed set, not the per-run agent provider",
    'model.add --provider':
      'names the provider of the model being registered; it is mandatory and spelled <provider>',
  };

  it('uses every group flag through its group reference, never inline', () => {
    const groupLongs = new Set(
      COMMAND_REGISTRY.option_groups.flatMap((group) => group.options.map((option) => option.long)),
    );
    const inline: string[] = [];
    for (const entry of COMMAND_REGISTRY.commands) {
      if (entry.kind !== 'leaf') continue;
      for (const ref of entry.options) {
        if ('group' in ref || !groupLongs.has(ref.long)) continue;
        const key = `${entry.id} ${ref.long}`;
        if (!(key in SPELLING_EXCEPTIONS)) inline.push(key);
      }
    }
    expect(inline).toEqual([]);
  });

  it('lists only exceptions that exist, each with a reason', () => {
    for (const [key, reason] of Object.entries(SPELLING_EXCEPTIONS)) {
      const [id, long] = key.split(' ');
      const entry = findLeaf(id!.split('.'))!;
      expect(entry.options.some((ref) => !('group' in ref) && ref.long === long)).toBe(true);
      expect(reason.length).toBeGreaterThan(0);
    }
  });

  it('spells each group option identically on every command that references it', () => {
    const spellings = new Map<string, Set<string>>();
    for (const entry of COMMAND_REGISTRY.commands) {
      if (entry.kind !== 'leaf') continue;
      for (const option of expandOptions(entry, COMMAND_REGISTRY.option_groups)) {
        if (option.group === undefined) continue;
        const seen = spellings.get(option.long) ?? new Set<string>();
        seen.add(`${option.flags}|${option.description}`);
        spellings.set(option.long, seen);
      }
    }
    for (const seen of spellings.values()) expect(seen.size).toBe(1);
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
