import type { LeafEntry } from '@yantra/protocol';
import { COMMAND_REGISTRY, expandOptions } from '@yantra/protocol/commands';

/**
 * The command a generated action runs, as a person would type it, with
 * placeholders: `yantra config set <key> <value>`. Required options appear
 * with their value (`yantra schedule <workflow-name> --cron <expr>`); every
 * other option is left to the form.
 */
export function commandTemplate(command: LeafEntry): string {
  const args = command.arguments.map((argument) => {
    const name = argument.variadic ? `${argument.name}...` : argument.name;
    return argument.required ? `<${name}>` : `[${name}]`;
  });
  const required = expandOptions(command, COMMAND_REGISTRY.option_groups)
    .filter((option) => option.mandatory)
    .map((option) => option.flags.replace(/^-\w, /u, ''));
  return ['yantra', ...command.path, ...args, ...required].join(' ');
}
