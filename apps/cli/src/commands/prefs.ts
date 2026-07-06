/**
 * `yantra prefs get|set|list|approve` + `--forget <key>` — manage personalization
 * preferences.
 *
 * The human-editable `profile.yaml` remains the primary surface; `prefs` manages
 * the machine layer and lets you inspect the merged effective view, approve
 * learned signals, and forget (truly delete) a value. Values are never logged
 * (they may be personal) and every subcommand supports `--json`.
 *
 * @example
 *   yantra prefs list
 *   yantra prefs set defaults.detail full
 *   yantra prefs get defaults.detail
 *   yantra prefs approve personalization.favorite_retailers
 *   yantra prefs --forget locale.region
 */

import { validatePreference, type Logger, type PreferenceStore } from '@yantra/core';
import { Command } from 'commander';

import { openPreferences } from '../preferences.js';
import { CLI_JSON_SCHEMA_VERSION } from '../render/json.js';
import { makeStderrLogger } from '../runtime.js';

interface PrefsOptions {
  readonly json?: boolean;
  readonly debug?: boolean;
  readonly forget?: string;
}

export function makePrefsCommand(): Command {
  const cmd = new Command('prefs');

  cmd
    .description('Manage personalization preferences (machine layer + merged view)')
    .argument('[action]', 'get | set | list | approve')
    .argument('[key]', 'dotted preference key (e.g. defaults.detail)')
    .argument('[value]', 'value (for set)')
    .option('--json', 'emit JSON', false)
    .option('--debug', 'verbose logging on stderr', false)
    .option('--forget <key>', 'delete a preference value (privacy control)')
    .action(
      async (
        action: string | undefined,
        key: string | undefined,
        value: string | undefined,
        options: PrefsOptions,
      ) => {
        const logger = makeStderrLogger(options.debug === true);

        // `--forget` is an action modifier usable without a positional action.
        if (options.forget !== undefined) {
          await runForget(options.forget, options, logger);
          return;
        }

        switch (action) {
          case undefined:
          case 'list':
            await runList(options, logger);
            return;
          case 'get':
            await runGet(key, options, logger);
            return;
          case 'set':
            await runSet(key, value, options, logger);
            return;
          case 'approve':
            await runApprove(key, options, logger);
            return;
          default:
            process.stderr.write(
              `Unknown action "${action}" (expected: get | set | list | approve)\n`,
            );
            process.exit(1);
        }
      },
    );

  return cmd;
}

async function withStore<T>(
  logger: Logger,
  fn: (store: PreferenceStore) => Promise<T>,
): Promise<T> {
  const handle = await openPreferences(logger);
  if (handle === null) {
    process.stderr.write('Error: preference index unavailable — run `yantra doctor`.\n');
    process.exit(3);
  }
  try {
    return await fn(handle.store);
  } finally {
    handle.close();
  }
}

async function runList(options: PrefsOptions, logger: Logger): Promise<void> {
  await withStore(logger, async (store) => {
    const result = await store.list();
    if (!result.isOk) {
      fail(result.error.message);
    }
    if (options.json === true) {
      emit('prefs', { rows: result.value });
    } else if (result.value.length === 0) {
      process.stdout.write(
        'No stored preferences. Edit ~/.config/yantra/profile.yaml or run `yantra prefs set`.\n',
      );
    } else {
      for (const row of result.value) {
        const flag =
          row.source === 'learned'
            ? row.approved
              ? '(learned, approved)'
              : '(learned, pending)'
            : '(user)';
        process.stdout.write(`${row.key} = ${JSON.stringify(row.value)} ${flag}\n`);
      }
    }
    process.exit(0);
  });
}

async function runGet(
  key: string | undefined,
  options: PrefsOptions,
  logger: Logger,
): Promise<void> {
  if (key === undefined) {
    fail('`prefs get` requires a key');
  }
  await withStore(logger, async (store) => {
    const result = await store.get(key);
    if (!result.isOk) {
      fail(result.error.message);
    }
    if (options.json === true) {
      emit('prefs', { key, record: result.value });
    } else if (result.value === null) {
      process.stdout.write(`${key} is not set.\n`);
    } else {
      process.stdout.write(`${result.value.key} = ${JSON.stringify(result.value.value)}\n`);
    }
    process.exit(0);
  });
}

async function runSet(
  key: string | undefined,
  value: string | undefined,
  options: PrefsOptions,
  logger: Logger,
): Promise<void> {
  if (key === undefined || value === undefined) {
    fail('`prefs set` requires a key and a value');
  }
  const validated = validatePreference(key, value);
  if (!validated.isOk) {
    fail(validated.error);
  }
  await withStore(logger, async (store) => {
    const result = await store.set(key, validated.value, { source: 'user' });
    if (!result.isOk) {
      fail(result.error.message);
    }
    if (options.json === true) {
      emit('prefs', { status: 'set', key, value: validated.value });
    } else {
      process.stdout.write(`Set ${key}.\n`);
    }
    process.exit(0);
  });
}

async function runApprove(
  key: string | undefined,
  options: PrefsOptions,
  logger: Logger,
): Promise<void> {
  if (key === undefined) {
    fail('`prefs approve` requires a key');
  }
  await withStore(logger, async (store) => {
    const result = await store.approve(key);
    if (!result.isOk) {
      fail(result.error.message);
    }
    if (options.json === true) {
      emit('prefs', { status: result.value ? 'approved' : 'not-found', key });
    } else {
      process.stdout.write(
        result.value ? `Approved ${key}.\n` : `${key} is not a stored preference.\n`,
      );
    }
    process.exit(result.value ? 0 : 1);
  });
}

async function runForget(key: string, options: PrefsOptions, logger: Logger): Promise<void> {
  await withStore(logger, async (store) => {
    const result = await store.forget(key);
    if (!result.isOk) {
      fail(result.error.message);
    }
    if (options.json === true) {
      emit('prefs', { status: result.value ? 'forgotten' : 'not-found', key });
    } else {
      process.stdout.write(result.value ? `Forgot ${key}.\n` : `${key} was not set.\n`);
    }
    process.exit(0);
  });
}

function emit(kind: string, body: Record<string, unknown>): void {
  process.stdout.write(
    `${JSON.stringify({ schemaVersion: CLI_JSON_SCHEMA_VERSION, kind, ...body })}\n`,
  );
}

function fail(message: string): never {
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
}
