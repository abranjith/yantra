import { describe, expect, it } from 'vitest';

import {
  conditionHolds,
  executionClassFor,
  jsonEqual,
  validateCommandRegistry,
  type LeafEntry,
} from '../../src/commands/index.js';

import { minimalRegistry } from './factories.js';

const registry = validateCommandRegistry(minimalRegistry());

function leafById(id: string): LeafEntry {
  const entry = registry.commands.find((candidate) => candidate.id === id);
  if (entry?.kind !== 'leaf') throw new Error(`no leaf ${id}`);
  return entry;
}

const doctor = leafById('doctor');
const prefs = leafById('prefs');
const configGet = leafById('config.get');

describe('@no-llm executionClassFor', () => {
  it('falls back to the default when no rule matches', () => {
    expect(
      executionClassFor(configGet, { options: { json: false }, arguments: { key: 'a' } }),
    ).toBe('read');
    expect(executionClassFor(doctor, { options: { agentSmoke: false }, arguments: {} })).toBe(
      'read',
    );
  });

  it('applies an option-present rule (doctor --agent-smoke → run)', () => {
    expect(executionClassFor(doctor, { options: { agentSmoke: true }, arguments: {} })).toBe('run');
    expect(
      executionClassFor(doctor, {
        options: { agentSmoke: false },
        arguments: {},
        explicit: ['agentSmoke'],
      }),
    ).toBe('run');
  });

  it('uses the explicit list over the value when one is given', () => {
    expect(
      executionClassFor(doctor, { options: { agentSmoke: true }, arguments: {}, explicit: [] }),
    ).toBe('read');
  });

  it('applies an argument-in rule (prefs set/approve → mutate)', () => {
    for (const action of ['set', 'approve']) {
      expect(executionClassFor(prefs, { options: {}, arguments: { action } })).toBe('mutate');
    }
    for (const action of ['get', 'list']) {
      expect(executionClassFor(prefs, { options: {}, arguments: { action } })).toBe('read');
    }
    expect(executionClassFor(prefs, { options: {}, arguments: {} })).toBe('read');
  });

  it('applies an option rule after argument rules (prefs --forget → mutate)', () => {
    expect(
      executionClassFor(prefs, { options: { forget: 'defaults.detail' }, arguments: {} }),
    ).toBe('mutate');
  });

  it('lets the first matching rule win', () => {
    const ordered = {
      execution: {
        default: 'read' as const,
        rules: [
          { when: { argument: 'action', in: ['set'] as [string] }, class: 'mutate' as const },
          { when: { argument: 'action', in: ['set'] as [string] }, class: 'run' as const },
        ],
      },
    };
    expect(executionClassFor(ordered, { options: {}, arguments: { action: 'set' } })).toBe(
      'mutate',
    );
  });
});

describe('@no-llm conditionHolds', () => {
  it('treats an unset negatable option (implicit true) as not present', () => {
    const condition = { option: '--no-llm', present: true as const };
    expect(conditionHolds(condition, { options: { llm: true }, arguments: {} })).toBe(false);
    expect(conditionHolds(condition, { options: { llm: false }, arguments: {} })).toBe(true);
  });

  it('compares equals conditions structurally', () => {
    const condition = { option: '--format', equals: 'terminal' };
    expect(conditionHolds(condition, { options: { format: 'terminal' }, arguments: {} })).toBe(
      true,
    );
    expect(conditionHolds(condition, { options: { format: 'json' }, arguments: {} })).toBe(false);
    expect(
      conditionHolds(
        { option: '--allow-host', equals: ['a', 'b'] },
        { options: { allowHost: ['a', 'b'] }, arguments: {} },
      ),
    ).toBe(true);
  });

  it('derives mode from --no-llm unless the mode is given', () => {
    const llm = { mode: 'llm' as const };
    expect(conditionHolds(llm, { options: {}, arguments: {} })).toBe(true);
    expect(conditionHolds(llm, { options: { llm: false }, arguments: {} })).toBe(false);
    expect(conditionHolds(llm, { options: {}, arguments: {}, mode: 'deterministic' })).toBe(false);
  });

  it('never matches an argument-in condition against a non-string value', () => {
    expect(
      conditionHolds(
        { argument: 'action', in: ['set'] },
        { options: {}, arguments: { action: ['set'] } },
      ),
    ).toBe(false);
  });
});

describe('@no-llm jsonEqual', () => {
  it('compares scalars, arrays and objects by value', () => {
    expect(jsonEqual(1, 1)).toBe(true);
    expect(jsonEqual('1', 1)).toBe(false);
    expect(jsonEqual([1, [2]], [1, [2]])).toBe(true);
    expect(jsonEqual([1], [1, 2])).toBe(false);
    expect(jsonEqual({ a: 1, b: [1] }, { b: [1], a: 1 })).toBe(true);
    expect(jsonEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(jsonEqual(null, {})).toBe(false);
    expect(jsonEqual([], {})).toBe(false);
  });
});
