import {
  createCredentialService,
  createKeychainProvider,
  CredentialKeyInvalidError,
  CredentialValueInvalidError,
  KeychainUnavailableError,
  validateCredentialKey,
  type KeychainProvider,
} from '@yantra/core';
import { type Command, CommanderError } from 'commander';

import { createTerminalContext } from '../adapters/terminal/terminal-adapter.js';
import type { CommandContext } from '../context/command-context.js';
import { createRegisteredCommand } from '../registry/build-command-tree.js';
import { handler } from '../registry/handler.js';
import { CLI_JSON_SCHEMA_VERSION } from '../render/json.js';

interface SecretOptions {
  readonly json?: boolean;
}

export interface SecretRuntime {
  readonly env: NodeJS.ProcessEnv;
  readonly stdin?: NodeJS.ReadableStream;
  readonly readInput?: () => Promise<string | null>;
  readonly json?: (value: unknown) => void;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly isTty: boolean;
  readonly createKeychain: () => Promise<KeychainProvider>;
  readonly promptSecret: (message: string) => Promise<string>;
}

export function makeSecretCommand(input?: Partial<SecretRuntime>): Command {
  return createRegisteredCommand('secret', secretHandlers(input));
}

/** Handlers for the `secret` family, bound by registry id. */
export function secretHandlers(
  input?: Partial<SecretRuntime>,
  context: CommandContext = createTerminalContext(input),
) {
  const runtime = runtimeWithDefaults(context, input);
  return {
    'secret.set': handler((args, options: SecretOptions) =>
      runSet(args[0] as string, args[1] as string | undefined, options, runtime),
    ),
    'secret.list': handler((_args, options: SecretOptions) => runList(options, runtime)),
    'secret.rm': handler((args, options: SecretOptions) =>
      runRemove(args[0] as string, options, runtime),
    ),
  } as const;
}

async function runSet(
  key: string,
  argvValue: string | undefined,
  options: SecretOptions,
  runtime: SecretRuntime,
): Promise<void> {
  await withCredentialErrors(runtime, async () => {
    validateCredentialKey(key);
    if (argvValue !== undefined)
      fail(
        runtime,
        'secret values are never accepted in argv because shell history and process listings can expose them',
      );
    const service = await credentials(runtime);
    await service.requireAvailable('set');
    const value = runtime.isTty
      ? await runtime.promptSecret(`Secret value for ${key}`)
      : await runtime.readInput?.();
    await service.setCredential({ key, value: value ?? '' });
  });
  if (options.json) emit(runtime, 'secret.set', { status: 'set', key });
  else runtime.stdout.write(`Stored ${key}.\n`);
}

async function runList(options: SecretOptions, runtime: SecretRuntime): Promise<void> {
  const { rows } = await withCredentialErrors(runtime, async () =>
    (await credentials(runtime)).listCredentials(),
  );
  const result = rows.map(({ key, source }) => ({ key, source }));
  if (options.json) emit(runtime, 'secret.list', { rows: result });
  else for (const row of result) runtime.stdout.write(`${row.key}\t${row.source}\n`);
}

async function runRemove(
  key: string,
  options: SecretOptions,
  runtime: SecretRuntime,
): Promise<void> {
  const { status } = await withCredentialErrors(runtime, async () => {
    validateCredentialKey(key);
    return (await credentials(runtime)).removeCredential({ key });
  });
  if (options.json) emit(runtime, 'secret.rm', { key, status });
  else runtime.stdout.write(`${key}\t${status}\n`);
}

async function credentials(runtime: SecretRuntime) {
  return createCredentialService({ keychain: await runtime.createKeychain(), env: runtime.env });
}

async function withCredentialErrors<T>(
  runtime: SecretRuntime,
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof KeychainUnavailableError) fail(runtime, error.message, 3);
    if (error instanceof CredentialKeyInvalidError || error instanceof CredentialValueInvalidError)
      fail(runtime, error.message);
    throw error;
  }
}

async function readPiped(stream: NodeJS.ReadableStream): Promise<string> {
  let value = '';
  stream.setEncoding('utf8');
  for await (const chunk of stream) value += String(chunk);
  return value.replace(/\r?\n$/u, '');
}

function emit(runtime: SecretRuntime, kind: string, body: Record<string, unknown>): void {
  runtime.json?.({ schemaVersion: CLI_JSON_SCHEMA_VERSION, kind, ...body });
}

function fail(runtime: SecretRuntime, message: string, code = 1): never {
  runtime.stderr.write(`Error: ${message}\n`);
  throw new CommanderError(code, 'yantra.secret.failed', message);
}

function runtimeWithDefaults(
  context: CommandContext,
  input?: Partial<SecretRuntime>,
): SecretRuntime {
  return {
    env: input?.env ?? context.settings.env(),
    stdout: input?.stdout ?? context.output.stdout,
    stderr: input?.stderr ?? context.output.stderr,
    isTty: input?.isTty ?? context.isInteractive({}),
    readInput:
      input?.readInput ??
      (input?.stdin
        ? () => readPiped(input.stdin!)
        : async () => (await context.input.stdin())?.replace(/\r?\n$/u, '') ?? null),
    json: (value) => context.output.json(value),
    createKeychain: input?.createKeychain ?? (() => createKeychainProvider()),
    promptSecret:
      input?.promptSecret ?? (async (message) => (await context.input.password(message)) ?? ''),
  };
}
