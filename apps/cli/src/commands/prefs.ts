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

import {
  defaultProfile,
  flattenProfile,
  loadProfile,
  validatePreference,
  type Logger,
  type PreferenceStore,
} from '@yantra/core';
import { type Command } from 'commander';

import { createTerminalContext } from '../adapters/terminal/terminal-adapter.js';
import { CommandFailure, type CommandContext } from '../context/command-context.js';
import { keyOwner } from '../key-ownership.js';
import { openPreferences } from '../preferences.js';
import { createRegisteredCommand } from '../registry/build-command-tree.js';
import { handler, type HandlerArgs } from '../registry/handler.js';
import { CLI_JSON_SCHEMA_VERSION } from '../render/json.js';
import { makeStderrLogger } from '../runtime.js';

interface PrefsOptions {
  readonly json?: boolean;
  readonly debug?: boolean;
  readonly forget?: string;
}

const SCREENSHOT_KEY = 'context.screenshots';
const SCREENSHOT_REVOCATION =
  'screenshot capture is now denied; existing captures in past run directories are not deleted';

export interface ScreenshotPreferenceWrite {
  readonly store: Pick<PreferenceStore, 'set'>;
  readonly key: string;
  readonly value: unknown;
  readonly json: boolean;
  readonly provider: string | null;
  readonly write: (text: string) => void;
}

export function makePrefsCommand(): Command {
  return createRegisteredCommand('prefs', { prefs: handler(prefsHandler) });
}

/** `yantra prefs [action] [key] [value]`: bound to the `prefs` registry entry. */
export async function prefsHandler(
  args: HandlerArgs,
  options: PrefsOptions,
  _command?: Command,
  context: CommandContext = createTerminalContext(),
): Promise<void> {
  const [action, key, value] = args as readonly [
    string | undefined,
    string | undefined,
    string | undefined,
  ];

  const logger = makeStderrLogger(options.debug === true, context.output.stderr);

  // `--forget` is an action modifier usable without a positional action.
  if (options.forget !== undefined) {
    await runForget(context, options.forget, options, logger);
    return;
  }

  switch (action) {
    case undefined:
    case 'list':
      await runList(context, options, logger);
      return;
    case 'get':
      await runGet(context, key, options, logger);
      return;
    case 'set':
      await runSet(context, key, value, options, logger);
      return;
    case 'approve':
      await runApprove(context, key, options, logger);
      return;
    default:
      context.output.stderr.write(
        `Unknown action "${action}" (expected: get | set | list | approve)\n`,
      );
      throw new CommandFailure(1, 'yantra.prefs.failed', '', null, true);
  }
}

async function withStore<T>(
  context: CommandContext,
  logger: Logger,
  fn: (store: PreferenceStore) => Promise<T>,
): Promise<T> {
  const handle = await openPreferences(logger);
  if (handle === null) {
    context.output.stderr.write('Error: preference index unavailable — run `yantra doctor`.\n');
    throw new CommandFailure(3, 'yantra.prefs.failed', '', null, true);
  }
  try {
    // prefs set/approve use the transactional SQLite machine layer, never
    // profile.yaml. Future ui.* preferences follow this same storage path.
    return await fn(handle.store);
  } finally {
    handle.close();
  }
}

async function runList(
  context: CommandContext,
  options: PrefsOptions,
  logger: Logger,
): Promise<void> {
  await withStore(context, logger, async (store) => {
    const result = await store.list();
    if (!result.isOk) {
      fail(context, result.error.message);
    }
    if (options.json === true) {
      emit(context, 'prefs', { rows: result.value });
    } else if (result.value.length === 0) {
      context.output.stdout.write(
        'No stored preferences. Edit ~/.yantra/profile.yaml or run `yantra prefs set`.\n',
      );
    } else {
      for (const row of result.value) {
        const flag =
          row.source === 'learned'
            ? row.approved
              ? '(learned, approved)'
              : '(learned, pending)'
            : '(user)';
        context.output.stdout.write(`${row.key} = ${JSON.stringify(row.value)} ${flag}\n`);
      }
    }
    return;
  });
}

async function runGet(
  context: CommandContext,
  key: string | undefined,
  options: PrefsOptions,
  logger: Logger,
): Promise<void> {
  if (key === undefined) {
    fail(context, '`prefs get` requires a key');
  }
  await withStore(context, logger, async (store) => {
    const result = await store.get(key);
    if (!result.isOk) {
      fail(context, result.error.message);
    }
    if (options.json === true) {
      emit(context, 'prefs', { key, record: result.value });
    } else if (result.value === null) {
      context.output.stdout.write(`${key} is not set.\n`);
    } else {
      context.output.stdout.write(`${result.value.key} = ${JSON.stringify(result.value.value)}\n`);
    }
    return;
  });
}

async function runSet(
  context: CommandContext,
  key: string | undefined,
  value: string | undefined,
  options: PrefsOptions,
  logger: Logger,
): Promise<void> {
  if (key === undefined || value === undefined) {
    fail(context, '`prefs set` requires a key and a value');
  }
  if (keyOwner(key) === 'config') {
    fail(context, `that is an installation key - use: yantra config set ${key} ${value}`);
  }
  const validated = validatePreference(key, value);
  if (!validated.isOk) {
    fail(context, validated.error);
  }
  await withStore(context, logger, async (store) => {
    const provider = await resolveEffectiveProvider(store);
    const result = await persistPreferenceSet({
      store,
      key,
      value: validated.value,
      json: options.json === true,
      provider,
      write: (text) => writePreferenceNotice(context, options.json === true, text),
    });
    if (!result.isOk) {
      fail(context, result.error.message);
    }
    if (options.json === true) {
      emit(context, 'prefs', { status: 'set', key, value: validated.value });
      emitScreenshotRevocation(key, validated.value, true, (text) =>
        writePreferenceNotice(context, options.json === true, text),
      );
    } else {
      context.output.stdout.write(`Set ${key}.\n`);
      emitScreenshotRevocation(key, validated.value, false, (text) =>
        writePreferenceNotice(context, options.json === true, text),
      );
    }
    return;
  });
}

async function runApprove(
  context: CommandContext,
  key: string | undefined,
  options: PrefsOptions,
  logger: Logger,
): Promise<void> {
  if (key === undefined) {
    fail(context, '`prefs approve` requires a key');
  }
  await withStore(context, logger, async (store) => {
    const result = await store.approve(key);
    if (!result.isOk) {
      fail(context, result.error.message);
    }
    if (options.json === true) {
      emit(context, 'prefs', { status: result.value ? 'approved' : 'not-found', key });
    } else {
      context.output.stdout.write(
        result.value ? `Approved ${key}.\n` : `${key} is not a stored preference.\n`,
      );
    }
    if (!result.value) throw new CommandFailure(1, 'yantra.prefs.failed', '', null, true);
  });
}

async function runForget(
  context: CommandContext,
  key: string,
  options: PrefsOptions,
  logger: Logger,
): Promise<void> {
  await withStore(context, logger, async (store) => {
    const result = await store.forget(key);
    if (!result.isOk) {
      fail(context, result.error.message);
    }
    if (options.json === true) {
      emit(context, 'prefs', { status: result.value ? 'forgotten' : 'not-found', key });
      emitScreenshotRevocation(key, false, true, (text) =>
        writePreferenceNotice(context, options.json === true, text),
      );
    } else {
      context.output.stdout.write(result.value ? `Forgot ${key}.\n` : `${key} was not set.\n`);
      emitScreenshotRevocation(key, false, false, (text) =>
        writePreferenceNotice(context, options.json === true, text),
      );
    }
    return;
  });
}

/** Writes informed screenshot consent before persisting the grant. */
export async function persistPreferenceSet(
  input: ScreenshotPreferenceWrite,
): ReturnType<PreferenceStore['set']> {
  if (input.key === SCREENSHOT_KEY && input.value === true) {
    emitScreenshotWarning(input.provider, input.json, input.write);
  }
  return input.store.set(input.key, input.value, { source: 'user' });
}

/** Emits the explicit non-retroactive revocation confirmation for screenshot denial. */
export function emitScreenshotRevocation(
  key: string,
  value: unknown,
  json: boolean,
  write: (text: string) => void,
): boolean {
  if (key !== SCREENSHOT_KEY || value !== false) {
    return false;
  }
  write(
    json
      ? `${JSON.stringify({
          schemaVersion: CLI_JSON_SCHEMA_VERSION,
          kind: 'prefs',
          status: 'revoked',
          key,
          message: SCREENSHOT_REVOCATION,
        })}\n`
      : `${SCREENSHOT_REVOCATION}.\n`,
  );
  return true;
}

function emitScreenshotWarning(
  provider: string | null,
  json: boolean,
  write: (text: string) => void,
): void {
  const exposes = [
    'raw, unmasked pixels that the sanitizer cannot inspect',
    'logged-in content',
    'names',
    'balances',
    'message bodies',
    'anything visible on screen',
  ] as const;
  const destination =
    provider?.toLowerCase() === 'ollama'
      ? 'sent to the local model runtime you configured, not a remote provider'
      : 'sent to the configured model provider';
  const retention = 'retained locally in the run directory and inside the raw provider session log';

  if (json) {
    write(
      `${JSON.stringify({
        schemaVersion: CLI_JSON_SCHEMA_VERSION,
        kind: 'prefs',
        status: 'warning',
        key: SCREENSHOT_KEY,
        exposes,
        destination,
        retention,
      })}\n`,
    );
    return;
  }
  write(
    `WARNING: Screenshot captures are ${exposes[0]}. They can expose ${exposes
      .slice(1)
      .join(', ')}. Captures are ${destination} and ${retention}.\n`,
  );
}

async function resolveEffectiveProvider(store: PreferenceStore): Promise<string | null> {
  const loaded = await loadProfile();
  const profile = loaded.isOk ? loaded.value : defaultProfile();
  const effective = await store.effective(flattenProfile(profile));
  if (!effective.isOk) {
    return profile.agent.provider;
  }
  const value = effective.value.get('agent.provider')?.value;
  return typeof value === 'string' ? value : null;
}

function emit(context: CommandContext, kind: string, body: Record<string, unknown>): void {
  context.output.json({ schemaVersion: CLI_JSON_SCHEMA_VERSION, kind, ...body });
}

function fail(context: CommandContext, message: string): never {
  context.output.stderr.write(`Error: ${message}\n`);
  throw new CommandFailure(1, 'yantra.prefs.failed', '', null, true);
}

function writePreferenceNotice(context: CommandContext, json: boolean, text: string): void {
  if (json) context.output.jsonLine(JSON.parse(text) as unknown);
  else context.output.stdout.write(text);
}
