/**
 * Registry ⇄ live commander tree agreement. Every difference is reported as
 * `<entry id> <field>: registry … vs live …`, so a failure names exactly what
 * drifted.
 */

import { expandOptions, type CommandEntry, type CommandRegistry } from '@yantra/protocol';

import type { WalkedCommand } from './walk-tree.js';

function differ(out: string[], id: string, field: string, registry: unknown, live: unknown): void {
  if (JSON.stringify(registry) !== JSON.stringify(live)) {
    out.push(
      `${id} ${field}: registry ${JSON.stringify(registry)} vs live ${JSON.stringify(live)}`,
    );
  }
}

/** Compares one registry entry with the live command at the same path. */
export function compareEntry(
  entry: CommandEntry,
  live: WalkedCommand,
  registry: CommandRegistry,
): readonly string[] {
  const out: string[] = [];
  const id = entry.id;
  differ(out, id, 'path', entry.path, live.path);
  differ(out, id, 'kind', entry.kind, live.kind);
  differ(out, id, 'description', entry.description, live.description);
  differ(out, id, 'aliases', entry.kind === 'leaf' ? entry.aliases : [], live.aliases);
  if (entry.kind !== 'leaf') return out;

  differ(
    out,
    id,
    'arguments',
    entry.arguments.map((argument) => ({
      name: argument.name,
      description: argument.description,
      required: argument.required,
      variadic: argument.variadic,
      default: argument.default,
    })),
    live.arguments.map((argument) => ({
      name: argument.name(),
      description: argument.description,
      required: argument.required,
      variadic: argument.variadic,
      default: argument.defaultValue as unknown,
    })),
  );

  const options = expandOptions(entry, registry.option_groups);
  differ(
    out,
    id,
    'option flags',
    options.map((option) => option.flags),
    live.options.map((option) => option.flags),
  );
  options.forEach((option, index) => {
    const liveOption = live.options[index];
    if (liveOption === undefined || liveOption.flags !== option.flags) return;
    const field = (name: string): string => `option ${option.long} ${name}`;
    differ(out, id, field('description'), option.description, liveOption.description);
    differ(out, id, field('default'), option.default, liveOption.defaultValue as unknown);
    differ(out, id, field('mandatory'), option.mandatory, liveOption.mandatory);
    const parserChoices =
      option.input.kind === 'enum' && option.input.enforced_by === 'parser'
        ? option.input.choices
        : undefined;
    differ(out, id, field('choices'), parserChoices, liveOption.argChoices);
    // Commander implements `.choices()` with its own arg parser, so only a
    // parser without choices is the CLI's `collect`.
    const liveRepeatable = liveOption.parseArg !== undefined && liveOption.argChoices === undefined;
    differ(out, id, field('repeatable'), option.repeatable, liveRepeatable);
  });
  return out;
}

/**
 * Compares every registry entry with the live tree: each entry must exist at
 * its path and agree field by field, and registry order must follow walk order.
 */
export function compareRegistryWithTree(
  registry: CommandRegistry,
  tree: readonly WalkedCommand[],
): readonly string[] {
  const out: string[] = [];
  const byPath = new Map(tree.map((node) => [node.path.join(' '), node]));
  let lastIndex = -1;
  for (const entry of registry.commands) {
    const live = byPath.get(entry.path.join(' '));
    if (live === undefined) {
      out.push(`${entry.id} path: no live command at "${entry.path.join(' ')}"`);
      continue;
    }
    const index = tree.indexOf(live);
    if (index < lastIndex) out.push(`${entry.id} order: listed after a later command`);
    lastIndex = Math.max(lastIndex, index);
    out.push(...compareEntry(entry, live, registry));
  }
  return out;
}
