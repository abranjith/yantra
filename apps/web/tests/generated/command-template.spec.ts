import { findLeaf } from '@yantra/protocol/commands';
import { describe, expect, it } from 'vitest';

import { commandTemplate } from '../../src/generated/command-template.js';
import { SURFACE_DEFINITIONS } from '../../src/surfaces/definitions.js';

function template(path: string): string {
  const command = findLeaf(path.split(' '));
  if (command === undefined) throw new Error(`No command ${path}`);
  return commandTemplate(command);
}

describe('@no-llm the command an action runs', () => {
  it('names required arguments in angle brackets and optional ones in square brackets', () => {
    expect(template('config set')).toBe('yantra config set <key> <value>');
    expect(template('prefs')).toBe('yantra prefs [action] [key] [value]');
  });

  it('includes a required option with its value', () => {
    expect(template('schedule')).toBe('yantra schedule <workflow-name> --cron <expr>');
  });

  it('starts every page action with yantra and the command path', () => {
    for (const action of SURFACE_DEFINITIONS.flatMap((surface) => surface.actions)) {
      expect(template(action.command).startsWith(`yantra ${action.command}`)).toBe(true);
    }
  });
});
