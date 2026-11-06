/**
 * Browser-safe barrel for the command registry (`@yantra/protocol/commands`).
 *
 * Nothing reachable from this module imports a Node built-in, so app bundles
 * can load the registry, the invocation parser and the shell formatter
 * without pulling in filesystem code. A boundary test enforces it.
 */

export {
  AdapterId,
  ArgumentSpec,
  CommandEntry,
  CommandRegistry,
  Condition,
  DangerSpec,
  ExecutionClass,
  ExecutionRule,
  ExecutionSpec,
  ExitCode,
  ExitCodeSpec,
  GroupEntry,
  InputKind,
  JsonResultSpec,
  JsonValue,
  LeafEntry,
  OptionGroup,
  OptionGroupId,
  OptionRef,
  OptionSpec,
  PrecedenceStep,
  Relation,
  type CommandEntryInput,
  type CommandRegistryInput,
  type OptionSpecInput,
} from './schema.js';
export { CommandRegistryError, type CommandRegistryRule } from './errors.js';
export { expandOptions, type ExpandedOption } from './expand.js';
export { attributeForLong, parseOptionFlags, type ParsedOptionFlags } from './flags.js';
export { validateCommandRegistry } from './validate.js';
export { conditionHolds, executionClassFor, jsonEqual, type InvocationFacts } from './execution.js';
