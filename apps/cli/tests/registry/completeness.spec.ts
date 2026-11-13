/**
 * Registry completeness: the live commander tree and the registry describe the
 * same command surface, and every leaf can execute. The handler check is a
 * runtime assertion because the `satisfies` guard in `src/registry/handlers.ts`
 * is enforced by `src` typecheck only; test files are outside it.
 */

import { COMMAND_REGISTRY, LEAF_COMMAND_IDS } from '@yantra/protocol';
import { describe, expect, it } from 'vitest';

import { buildProgram } from '../../src/program.js';
import { buildHandlers } from '../../src/registry/handlers.js';
import { UNMIGRATED_COMMANDS } from '../../src/registry/unmigrated.js';

import { listCommands } from './walk-tree.js';

const livePaths = listCommands(buildProgram())
  .filter((node) => node.kind !== 'root')
  .map((node) => node.path.join(' '));
const registryPaths = COMMAND_REGISTRY.commands.map((entry) => entry.path.join(' '));

describe('@no-llm command registry completeness', () => {
  it('has a registry entry for every live command path', () => {
    expect(livePaths.filter((path) => !registryPaths.includes(path))).toEqual([]);
  });

  it('has a live command for every registry entry', () => {
    expect(registryPaths.filter((path) => !livePaths.includes(path))).toEqual([]);
  });

  it('lists both in the same order', () => {
    expect(registryPaths).toEqual(livePaths);
  });

  it('gives every leaf an execution class', () => {
    const leaves = COMMAND_REGISTRY.commands.filter((entry) => entry.kind === 'leaf');
    expect(leaves).toHaveLength(53);
    for (const leaf of leaves) expect(leaf.execution.default).toEqual(expect.any(String));
  });

  it('binds every leaf to a function and nothing else', () => {
    const handlers = buildHandlers() as Readonly<Record<string, unknown>>;
    const unbound = LEAF_COMMAND_IDS.filter((id) => typeof handlers[id] !== 'function');
    expect(unbound).toEqual([]);
    expect(Object.keys(handlers).sort()).toEqual([...LEAF_COMMAND_IDS].sort());
  });

  it('generates every family: the unmigrated allowlist is empty', () => {
    expect(UNMIGRATED_COMMANDS).toEqual([]);
  });
});
