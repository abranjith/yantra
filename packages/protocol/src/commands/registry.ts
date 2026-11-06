/**
 * The Yantra command registry: every command in root-help order, each group
 * followed by its subcommands in their help order. The CLI generates its
 * commander tree from this data.
 */

import { ask, doCommand, research } from './entries/agentic.js';
import { browser, browserList } from './entries/browser.js';
import { daemon, daemonStatus } from './entries/daemon.js';
import { doctor } from './entries/doctor.js';
import { audit, list, report, show, usage } from './entries/runs.js';
import {
  config,
  configDataDir,
  configEdit,
  configGet,
  configList,
  configPath,
  configSet,
  configUnset,
  configValidate,
  init,
  model,
  modelAdd,
  modelDefault,
  modelList,
  modelRm,
  prefs,
  profile,
  secret,
  secretList,
  secretRm,
  secretSet,
  sites,
  sitesAdd,
  sitesList,
  sitesRemove,
} from './entries/settings.js';
import { template, templateList, templateShow } from './entries/template.js';
import { resume, run, schedules } from './entries/workflow.js';
import { OPTION_GROUP_INPUTS } from './groups.js';
import {
  CommandRegistry,
  type CommandEntry,
  type CommandRegistryInput,
  type LeafEntry,
} from './schema.js';

const ENTRIES = [
  ask,
  research,
  doCommand,
  run,
  config,
  configPath,
  configList,
  configGet,
  configSet,
  configUnset,
  configEdit,
  configValidate,
  configDataDir,
  secret,
  secretSet,
  secretList,
  secretRm,
  resume,
  schedules,
  daemon,
  daemonStatus,
  list,
  model,
  modelList,
  modelAdd,
  modelRm,
  modelDefault,
  show,
  usage,
  profile,
  prefs,
  sites,
  sitesList,
  sitesAdd,
  sitesRemove,
  template,
  templateList,
  templateShow,
  doctor,
  audit,
  report,
  init,
  browser,
  browserList,
] as const;

/** The dotted id of every executable command in the registry. */
export type LeafCommandId = Extract<(typeof ENTRIES)[number], { kind: 'leaf' }>['id'];

/** The dotted id of every registry entry, groups included. */
export type CommandId = (typeof ENTRIES)[number]['id'];

/** The registry as authored, before schema defaults are applied. */
export const COMMAND_REGISTRY_INPUT: CommandRegistryInput = {
  registry_version: 1,
  program: {
    name: 'yantra',
    description: 'Yantra — AI-orchestrated browser automation, local-first',
  },
  option_groups: [...OPTION_GROUP_INPUTS],
  commands: [...ENTRIES],
};

/**
 * The parsed registry with schema defaults applied. Cross-entry rules are
 * enforced by `validateCommandRegistry` in tests, not at import time.
 */
export const COMMAND_REGISTRY: CommandRegistry = CommandRegistry.parse(COMMAND_REGISTRY_INPUT);

/** Every leaf id, in registry order. */
export const LEAF_COMMAND_IDS: readonly LeafCommandId[] = ENTRIES.filter(
  (entry): entry is Extract<(typeof ENTRIES)[number], { kind: 'leaf' }> => entry.kind === 'leaf',
).map((entry) => entry.id);

/**
 * Finds the entry at a command path, resolving aliases at each level
 * (`['discover']` finds `do`). Returns `undefined` for an unknown path.
 */
export function findCommand(
  path: readonly string[],
  registry: CommandRegistry = COMMAND_REGISTRY,
): CommandEntry | undefined {
  let prefix: readonly string[] = [];
  let found: CommandEntry | undefined;
  for (const token of path) {
    found = registry.commands.find(
      (entry) =>
        entry.path.length === prefix.length + 1 &&
        entry.path.slice(0, -1).every((part, index) => part === prefix[index]) &&
        (entry.path.at(-1) === token || (entry.kind === 'leaf' && entry.aliases.includes(token))),
    );
    if (found === undefined) return undefined;
    prefix = found.path;
  }
  return found;
}

/** Narrows {@link findCommand} to executable leaves. */
export function findLeaf(
  path: readonly string[],
  registry: CommandRegistry = COMMAND_REGISTRY,
): LeafEntry | undefined {
  const entry = findCommand(path, registry);
  return entry?.kind === 'leaf' ? entry : undefined;
}
