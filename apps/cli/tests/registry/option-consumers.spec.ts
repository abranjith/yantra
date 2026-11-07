/**
 * No command registers an option it cannot act on (plan §12, FEAT-062): every
 * option of every leaf must have a consumer in the leaf's handler module or a
 * module it imports directly. Verified exceptions live in KNOWN_DEAD_OPTIONS,
 * a dated list that may only shrink (spec §1 DEVIATION; `.spec-lite/TODO.md`).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { COMMAND_REGISTRY, expandOptions, type LeafEntry } from '@yantra/protocol';
import { describe, expect, it } from 'vitest';

import { DEAD_OPTION_TODO as TODO, KNOWN_DEAD_OPTIONS } from '../../src/registry/dead-options.js';

import { factsOf, handlerFacts, isConsumed, mergeFacts } from './option-consumers.js';

const commandsDir = resolve(import.meta.dirname, '..', '..', 'src', 'commands');

/** The module whose exported handler a leaf is bound to. */
function handlerModule(entry: LeafEntry): string {
  const family = entry.path[0]!;
  const file = family === 'schedules' || family === 'unschedule' ? 'schedule' : family;
  return resolve(commandsDir, `${file}.ts`);
}

export { KNOWN_DEAD_OPTIONS } from '../../src/registry/dead-options.js';

const leaves = COMMAND_REGISTRY.commands.filter(
  (entry): entry is LeafEntry => entry.kind === 'leaf',
);

function deadOptions(): readonly string[] {
  const dead: string[] = [];
  for (const entry of leaves) {
    const facts = handlerFacts(handlerModule(entry));
    for (const option of expandOptions(entry, COMMAND_REGISTRY.option_groups)) {
      if (!isConsumed(option, facts)) dead.push(`${entry.id} ${option.long}`);
    }
  }
  return dead;
}

describe('@no-llm every registered option has a consumer', () => {
  const dead = deadOptions();
  const known = KNOWN_DEAD_OPTIONS.map((item) => `${item.command} ${item.option}`);
  const refused = new Set(
    KNOWN_DEAD_OPTIONS.filter((item) => item.kind === 'refused').map(
      (item) => `${item.command} ${item.option}`,
    ),
  );

  it('finds a consumer for every option outside KNOWN_DEAD_OPTIONS', () => {
    expect(dead.filter((key) => !known.includes(key))).toEqual([]);
  });

  it('removes a known-dead entry once its option gains a consumer (the list only shrinks)', () => {
    const unread = KNOWN_DEAD_OPTIONS.filter((item) => item.kind === 'unread').map(
      (item) => `${item.command} ${item.option}`,
    );
    expect(unread.filter((key) => !dead.includes(key))).toEqual([]);
  });

  it('keeps each refused option refused, as its recorded evidence shows', () => {
    for (const item of KNOWN_DEAD_OPTIONS.filter((candidate) => candidate.kind === 'refused')) {
      const entry = leaves.find((leaf) => leaf.id === item.command)!;
      expect({
        key: `${item.command} ${item.option}`,
        refused: readFileSync(handlerModule(entry), 'utf8').includes(item.evidence),
      }).toEqual({
        key: `${item.command} ${item.option}`,
        refused: true,
      });
    }
    expect(refused.size).toBe(KNOWN_DEAD_OPTIONS.filter((i) => i.kind === 'refused').length);
  });

  it('names only options the registry registers, each once, with a date and a TODO', () => {
    for (const item of KNOWN_DEAD_OPTIONS) {
      const entry = leaves.find((leaf) => leaf.id === item.command);
      const longs = entry
        ? expandOptions(entry, COMMAND_REGISTRY.option_groups).map((option) => option.long)
        : [];
      expect({
        key: `${item.command} ${item.option}`,
        registered: longs.includes(item.option),
      }).toEqual({
        key: `${item.command} ${item.option}`,
        registered: true,
      });
      expect(item.since).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(item.evidence.length).toBeGreaterThan(0);
      expect(item.todo).toBe(TODO);
    }
    expect(new Set(known).size).toBe(known.length);
  });
});

describe('@no-llm option consumer analysis', () => {
  const json = expandOptions(leaves.find((leaf) => leaf.id === 'config.path')!, []).find(
    (option) => option.long === '--json',
  )!;
  const budget = expandOptions(
    leaves.find((leaf) => leaf.id === 'do')!,
    COMMAND_REGISTRY.option_groups,
  ).find((option) => option.long === '--max-duration')!;

  it('accepts a module that reads options.json', () => {
    const facts = factsOf(
      'export function h(options: { json?: boolean }) { return options.json === true; }',
    );
    expect(isConsumed(json, facts)).toBe(true);
  });

  it.each([
    "function h(opts: Record<string, unknown>) { return opts['json']; }",
    'function h(options: { json?: boolean }) { const { json } = options; return json; }',
    'function h(options?: { json?: boolean }) { return options?.json; }',
  ])('accepts the other read forms: %s', (source) => {
    expect(isConsumed(json, factsOf(source))).toBe(true);
  });

  it('rejects a module that ignores --json', () => {
    const facts = factsOf('export function h(options: { json?: boolean }) { return 1; }');
    expect(isConsumed(json, facts)).toBe(false);
  });

  it('does not count an assignment as a read', () => {
    expect(
      isConsumed(json, factsOf('function h(options: { json?: boolean }) { options.json = true; }')),
    ).toBe(false);
  });

  it('rejects a budget group consumer that resolves the agent but passes budgets: {}', () => {
    const facts = factsOf(`
      async function h(options) {
        const agent = await resolveAgentInvocation('run', options, process.env);
        return runWorkflow({ model: agent.model, budgets: {} });
      }`);
    expect(isConsumed(budget, facts)).toBe(false);
  });

  it('accepts a budget group consumer that hands the resolved budgets on', () => {
    const facts = factsOf(`
      async function h(options) {
        const agent = await resolveAgentInvocation('do', options, process.env);
        return run({ budgets: agent.budgets });
      }`);
    expect(isConsumed(budget, facts)).toBe(true);
  });

  it('merges a module with its direct imports', () => {
    const merged = mergeFacts([factsOf('import "./a.js";'), factsOf('options.json;')]);
    expect(isConsumed(json, merged)).toBe(true);
  });
});
