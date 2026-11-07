/** Rules `validateCommandRegistry` enforces, named so a failure says which one broke. */
export type CommandRegistryRule =
  | 'schema'
  | 'missing-execution'
  | 'duplicate-id'
  | 'id-path-mismatch'
  | 'orphan-subcommand'
  | 'empty-group'
  | 'alias-collision'
  | 'duplicate-option-group'
  | 'unknown-option-group'
  | 'flags-mismatch'
  | 'duplicate-option'
  | 'input-kind-mismatch'
  | 'default-type-mismatch'
  | 'enum-default-outside-choices'
  | 'precedence-shape'
  | 'duplicate-argument'
  | 'argument-order'
  | 'argument-default'
  | 'unknown-condition-target'
  | 'unknown-relation-target'
  | 'adapter-required'
  | 'exemption-required'
  | 'json-flag-mismatch'
  | 'exit-codes-missing-zero'
  | 'duplicate-exit-code'
  | 'missing-handler';

/**
 * A command registry violates one of its rules. Carries the offending entry
 * (or option group) id and the rule, so the message is actionable.
 */
export class CommandRegistryError extends Error {
  public readonly entryId: string;
  public readonly rule: CommandRegistryRule;

  public constructor(entryId: string, rule: CommandRegistryRule, detail: string) {
    super(`command registry entry "${entryId}" violates ${rule}: ${detail}`);
    this.name = 'CommandRegistryError';
    this.entryId = entryId;
    this.rule = rule;
  }
}
