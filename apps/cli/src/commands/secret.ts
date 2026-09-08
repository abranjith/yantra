import {
  createKeychainProvider,
  loadConfig,
  parseConfigRef,
  YANTRA_KEYCHAIN_SERVICE,
  type ConfigRef,
  type KeychainProvider,
} from '@yantra/core';
import { Command, CommanderError } from 'commander';
import prompts from 'prompts';

import { CLI_JSON_SCHEMA_VERSION } from '../render/json.js';

interface SecretOptions {
  readonly json?: boolean;
}

export interface SecretRuntime {
  readonly env: NodeJS.ProcessEnv;
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly isTty: boolean;
  readonly createKeychain: () => Promise<KeychainProvider>;
  readonly promptSecret: (message: string) => Promise<string>;
}

export function makeSecretCommand(input?: Partial<SecretRuntime>): Command {
  const runtime = runtimeWithDefaults(input);
  const command = new Command('secret').description('Manage credentials in the OS keychain');
  command
    .command('set')
    .argument('<key>')
    .argument('[value]')
    .option('--json', 'emit JSON', false)
    .action((key: string, value: string | undefined, options: SecretOptions) =>
      runSet(key, value, options, runtime),
    );
  command
    .command('list')
    .option('--json', 'emit JSON', false)
    .action((options: SecretOptions) => runList(options, runtime));
  command
    .command('rm')
    .argument('<key>')
    .option('--json', 'emit JSON', false)
    .action((key: string, options: SecretOptions) => runRemove(key, options, runtime));
  return command;
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
    : await readPiped(runtime.stdin);
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
  runtime.stdout.write(
    `${JSON.stringify({ schemaVersion: CLI_JSON_SCHEMA_VERSION, kind, ...body })}\n`,
  );
}

function fail(runtime: SecretRuntime, message: string, code = 1): never {
  runtime.stderr.write(`Error: ${message}\n`);
  throw new CommanderError(code, 'yantra.secret.failed', message);
}

function runtimeWithDefaults(input?: Partial<SecretRuntime>): SecretRuntime {
  return {
    env: input?.env ?? process.env,
    stdin: input?.stdin ?? process.stdin,
    stdout: input?.stdout ?? process.stdout,
    stderr: input?.stderr ?? process.stderr,
    isTty: input?.isTty ?? process.stdin.isTTY ?? false,
    createKeychain: input?.createKeychain ?? (() => createKeychainProvider()),
    promptSecret:
      input?.promptSecret ??
      (async (message) => {
        const answer = await prompts({ type: 'password', name: 'value', message });
        return typeof answer.value === 'string' ? answer.value : '';
      }),
  };
}
