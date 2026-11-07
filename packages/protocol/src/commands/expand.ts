import { CommandRegistryError } from './errors.js';
import type { LeafEntry, OptionGroup, OptionGroupId, OptionRef, OptionSpec } from './schema.js';

/** An option after group expansion, remembering the group it came from. */
export type ExpandedOption = OptionSpec & { readonly group?: OptionGroupId };

function isGroupRef(ref: OptionRef): ref is { group: OptionGroupId } {
  return 'group' in ref;
}

/**
 * Expands a leaf's option references in place, preserving registration (help)
 * order: each `{ group }` becomes that group's options at its position.
 *
 * @throws {CommandRegistryError} `unknown-option-group` for a reference to a
 * group the registry does not define.
 */
export function expandOptions(
  entry: Pick<LeafEntry, 'id' | 'options'>,
  groups: readonly OptionGroup[],
): readonly ExpandedOption[] {
  const expanded: ExpandedOption[] = [];
  for (const ref of entry.options) {
    if (!isGroupRef(ref)) {
      expanded.push(ref);
      continue;
    }
    const group = groups.find((candidate) => candidate.id === ref.group);
    if (group === undefined) {
      throw new CommandRegistryError(
        entry.id,
        'unknown-option-group',
        `references option group "${ref.group}", which the registry does not define`,
      );
    }
    for (const option of group.options) expanded.push({ ...option, group: group.id });
  }
  return expanded;
}
