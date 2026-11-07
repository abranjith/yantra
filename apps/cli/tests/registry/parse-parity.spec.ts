/**
 * `parseInvocation` (protocol) agrees with the generated commander tree, for
 * every leaf: it succeeds exactly when commander reaches the leaf's handler,
 * and then yields the same arguments and options commander passed.
 */

import {
  COMMAND_REGISTRY,
  LEAF_COMMAND_IDS,
  parseInvocation,
  type LeafEntry,
} from '@yantra/protocol';
import { CommanderError } from 'commander';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { leafArgv } from '../../../../packages/protocol/tests/commands/argv-arbitraries.js';
import { buildProgram } from '../../src/program.js';
import type { HandlerTable } from '../../src/registry/build-command-tree.js';

import { walkCommandTree } from './walk-tree.js';

const RUNS_PER_LEAF = 200;

interface Recorded {
  readonly id: string;
  readonly args: readonly unknown[];
  readonly options: Readonly<Record<string, unknown>>;
}

type CommanderOutcome =
  | { readonly ok: true; readonly call: Recorded }
  | { readonly ok: false; readonly code: string };

async function commanderParse(argv: readonly string[]): Promise<CommanderOutcome> {
  let call: Recorded | undefined;
  const handlers: HandlerTable = Object.fromEntries(
    LEAF_COMMAND_IDS.map((id) => [
      id,
      (args: readonly unknown[], options: Readonly<Record<string, unknown>>) => {
        call = { id, args, options: { ...options } };
      },
    ]),
  );
  const program = buildProgram({}, handlers);
  for (const node of walkCommandTree(program)) {
    node.command.exitOverride();
    node.command.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
  }
  try {
    await program.parseAsync([...argv], { from: 'user' });
  } catch (error) {
    if (error instanceof CommanderError) return { ok: false, code: error.code };
    throw error;
  }
  return call === undefined ? { ok: false, code: 'no-action' } : { ok: true, call };
}

function argumentRecord(entry: LeafEntry, args: readonly unknown[]): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  entry.arguments.forEach((argument, index) => {
    if (args[index] !== undefined) record[argument.name] = args[index];
  });
  return record;
}

async function agree(argv: readonly string[]): Promise<void> {
  const expected = await commanderParse(argv);
  const actual = parseInvocation(argv, { cwd: '/work' });
  expect({ argv, ok: actual.isOk }).toEqual({ argv, ok: expected.ok });
  if (!actual.isOk || !expected.ok) return;
  expect(actual.value.entry.id).toBe(expected.call.id);
  expect(actual.value.arguments).toEqual(argumentRecord(actual.value.entry, expected.call.args));
  expect(actual.value.options).toEqual(expected.call.options);
}

const leaves = COMMAND_REGISTRY.commands.filter(
  (entry): entry is LeafEntry => entry.kind === 'leaf',
);

describe('@no-llm parseInvocation agrees with the generated commander tree', () => {
  it('covers every leaf', () => {
    expect(leaves.map((leaf) => leaf.id)).toEqual([...LEAF_COMMAND_IDS]);
  });

  it.each(leaves.map((leaf) => [leaf.id, leaf] as const))(
    '%s: valid and near-valid argv',
    async (_id, entry) => {
      await fc.assert(
        fc.asyncProperty(
          fc.oneof(
            leafArgv(entry, COMMAND_REGISTRY.option_groups, { nearValid: false }),
            leafArgv(entry, COMMAND_REGISTRY.option_groups, { nearValid: true }),
          ),
          agree,
        ),
        { numRuns: RUNS_PER_LEAF },
      );
    },
    60_000,
  );

  it.each([
    [[]],
    [['nope']],
    [['config']],
    [['config', 'nope']],
    [['help', 'nope']],
    [['--json', 'list']],
    [['--', 'show', '-x']],
    [['list', '-5']],
    [['-Vx']],
    [['list', '--version=1']],
    [['run', '-p', 'a=1', 'wf']],
  ])('agrees on the edge case %j', async (argv) => {
    await agree(argv);
  });

  it('reaches at least one success per leaf in valid mode', async () => {
    for (const entry of leaves) {
      const samples = fc.sample(
        leafArgv(entry, COMMAND_REGISTRY.option_groups, { nearValid: false }),
        {
          numRuns: 20,
          seed: 7,
        },
      );
      const outcomes = await Promise.all(samples.map((argv) => commanderParse(argv)));
      expect({ id: entry.id, success: outcomes.some((o) => o.ok) }).toEqual({
        id: entry.id,
        success: true,
      });
    }
  }, 120_000);

  it('reaches at least one parse error per leaf in near-valid mode', async () => {
    for (const entry of leaves) {
      const samples = fc.sample(
        leafArgv(entry, COMMAND_REGISTRY.option_groups, { nearValid: true }),
        {
          numRuns: 40,
          seed: 11,
        },
      );
      const outcomes = await Promise.all(samples.map((argv) => commanderParse(argv)));
      expect({ id: entry.id, failure: outcomes.some((o) => !o.ok) }).toEqual({
        id: entry.id,
        failure: true,
      });
    }
  }, 120_000);
});
