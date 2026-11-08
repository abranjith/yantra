import {
  createKeychainProvider,
  loadConfig,
  parseConfigRef,
  YANTRA_KEYCHAIN_SERVICE,
  type ConfigRef,
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
  validateKey(key, runtime);
  if (argvValue !== undefined)
    fail(
      runtime,
      'secret values are never accepted in argv because shell history and process listings can expose them',
    );
  const keychain = await runtime.createKeychain();
  if (!(await keychain.isAvailable())) unavailable(runtime);
  const value = runtime.isTty
    ? await runtime.promptSecret(`Secret value for ${key}`)
    : await runtime.readInput?.();
  if (!value) fail(runtime, 'secret value must not be empty');
  await keychain.set(YANTRA_KEYCHAIN_SERVICE, key, value);
  if (options.json) emit(runtime, 'secret.set', { status: 'set', key });
  else runtime.stdout.write(`Stored ${key}.\n`);
}

async function runList(options: SecretOptions, runtime: SecretRuntime): Promise<void> {
  const keychain = await runtime.createKeychain();
  const available = await keychain.isAvailable();
  const stored = available ? await keychain.list(YANTRA_KEYCHAIN_SERVICE) : [];
  const rows = new Map<string, 'keychain' | 'env' | 'absent'>();
  for (const entry of stored) rows.set(entry.account, 'keychain');
  const loaded = await loadConfig();
  if (loaded.isOk) {
    for (const provider of ['tavily', 'brave'] as const) {
      const account = `${provider}.api_key`;
      const ref = loaded.value.search[provider].api_key;
      const displayKey = ref?.kind === 'secret' ? ref.key : account;
      rows.set(displayKey, sourceFor(ref, runtime.env, rows.get(displayKey)));
    }
    for (const model of loaded.value.models) {
      if (model.api_key?.kind === 'secret')
        rows.set(model.api_key.key, rows.get(model.api_key.key) ?? 'absent');
      else if (model.api_key?.kind === 'env')
        rows.set(
          `${model.provider}/${model.id}`,
          runtime.env[model.api_key.name] ? 'env' : 'absent',
        );
    }
  }
  const result = [...rows]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, source]) => ({ key, source }));
  if (options.json) emit(runtime, 'secret.list', { rows: result });
  else for (const row of result) runtime.stdout.write(`${row.key}\t${row.source}\n`);
}

async function runRemove(
  key: string,
  options: SecretOptions,
  runtime: SecretRuntime,
): Promise<void> {
  validateKey(key, runtime);
  const keychain = await runtime.createKeychain();
  if (!(await keychain.isAvailable())) unavailable(runtime);
  const removed = await keychain.delete(YANTRA_KEYCHAIN_SERVICE, key);
  const status = removed ? 'removed' : 'absent';
  if (options.json) emit(runtime, 'secret.rm', { key, status });
  else runtime.stdout.write(`${key}\t${status}\n`);
}

function sourceFor(
  ref: ConfigRef | null,
  env: NodeJS.ProcessEnv,
  stored: 'keychain' | 'env' | 'absent' | undefined,
): 'keychain' | 'env' | 'absent' {
  if (!ref) return stored ?? 'absent';
  if (ref.kind === 'env') return env[ref.name] ? 'env' : 'absent';
  return stored ?? 'absent';
}

function validateKey(key: string, runtime: SecretRuntime): void {
  const parsed = parseConfigRef(`\${secret:${key}}`);
  if (!parsed.isOk) fail(runtime, `${parsed.error}; expected a key such as tavily.api_key`);
}

async function readPiped(stream: NodeJS.ReadableStream): Promise<string> {
  let value = '';
  stream.setEncoding('utf8');
  for await (const chunk of stream) value += String(chunk);
  return value.replace(/\r?\n$/u, '');
}

function unavailable(runtime: SecretRuntime): never {
  const remedy =
    process.platform === 'linux'
      ? 'install libsecret and start a Secret Service'
      : process.platform === 'darwin'
        ? 'unlock the login keychain'
        : 'enable Windows Credential Manager';
  fail(runtime, `OS keychain unavailable; ${remedy}, or use a \${env:NAME} reference`, 3);
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
