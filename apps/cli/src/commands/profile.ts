/**
 * `yantra profile` — shows the merged effective preferences and where each
 * value came from (`profile.yaml` vs the machine `index.db` layer).
 *
 * This is the read-only "what does Yantra know about me, and why" surface. The
 * human-editable source of truth is `~/.yantra/profile.yaml`; use
 * `yantra prefs` to manage the machine layer and `--forget` to delete values.
 *
 * @example
 *   yantra profile
 *   yantra profile --json
 */

import { profilePath } from '@yantra/core';
import type { Command } from 'commander';

import { createTerminalContext } from '../adapters/terminal/terminal-adapter.js';
import { type CommandContext } from '../context/command-context.js';
import { loadEffectivePreferences } from '../preferences.js';
import type { HandlerArgs } from '../registry/handler.js';
import { CLI_JSON_SCHEMA_VERSION } from '../render/json.js';
import { makeStderrLogger } from '../runtime.js';

interface ProfileOptions {
  readonly json?: boolean;
  readonly debug?: boolean;
}

/** `yantra profile`: bound to the `profile` registry entry. */
export async function profileHandler(
  _args: HandlerArgs,
  options: ProfileOptions,
  _command?: Command,
  context: CommandContext = createTerminalContext(),
): Promise<void> {
  const logger = makeStderrLogger(options.debug === true, context.output.stderr);
  const effective = await loadEffectivePreferences(logger);

  const rows = [...effective.values()].sort((a, b) => a.key.localeCompare(b.key));

  if (options.json === true) {
    context.output.json({
      schemaVersion: CLI_JSON_SCHEMA_VERSION,
      kind: 'profile',
      profilePath: profilePath(),
      preferences: rows,
    });
    return;
  }

  context.output.stdout.write(`Profile file: ${profilePath()} (yours to edit)\n\n`);
  if (rows.length === 0) {
    context.output.stdout.write('No preferences resolved.\n');
    return;
  }

  const keyWidth = Math.max(...rows.map((r) => r.key.length));
  for (const row of rows) {
    const approval = row.source === 'learned' && !row.approved ? ' [pending approval]' : '';
    context.output.stdout.write(
      `${row.key.padEnd(keyWidth)}  ${JSON.stringify(row.value)}  ` +
        `(${row.provenance})${approval}\n`,
    );
  }
  return;
}
