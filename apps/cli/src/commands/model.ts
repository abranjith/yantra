import {
  createKeychainProvider,
  loadConfig,
  loadProfile,
  parseConfigRef,
  redactConfigRefs,
  saveProfile,
  setConfigKey,
  YANTRA_KEYCHAIN_SERVICE,
  type ModelConfig,
} from '@yantra/core';
import { Command, CommanderError } from 'commander';

import { CLI_JSON_SCHEMA_VERSION } from '../render/json.js';

interface ModelOptions {
  readonly json?: boolean;
  readonly provider?: string;
  readonly baseUrl?: string;
  readonly apiKeyRef?: string;
  readonly input?: string;
  readonly force?: boolean;
}

export function makeModelCommand(): Command {
  const command = new Command('model').description('Manage the installed model registry');
  command
    .command('list')
    .option('--json', 'emit JSON', false)
    .action((options: ModelOptions) => runList(options));
  command
    .command('add')
    .argument('<id>')
    .requiredOption('--provider <provider>')
    .option('--base-url <url>')
    .option('--api-key-ref <reference>')
    .option('--input <kinds>', 'comma-separated: text,image', 'text')
    .option('--force', 'replace an existing provider/id pair', false)
    .option('--json', 'emit JSON', false)
    .action((id: string, options: ModelOptions) => runAdd(id, options));
  command
    .command('rm')
    .argument('<id>')
    .option('--force', 'remove even when selected as default', false)
    .option('--json', 'emit JSON', false)
    .action((id: string, options: ModelOptions) => runRemove(id, options));
  command
    .command('default')
    .argument('<id>')
    .option('--json', 'emit JSON', false)
    .action((id: string, options: ModelOptions) => runDefault(id, options));
  return command;
}

async function config() {
  const loaded = await loadConfig();
  if (!loaded.isOk) fail(loaded.error.message);
  return loaded.value;
}

async function runAdd(id: string, options: ModelOptions): Promise<void> {
  const provider = options.provider?.trim().toLowerCase();
  if (!provider) fail('--provider must not be empty');
  let apiKey = null;
  if (options.apiKeyRef) {
    const parsed = parseConfigRef(options.apiKeyRef);
    if (!parsed.isOk) fail(`${parsed.error}; use yantra secret set for literal credentials`);
    apiKey = parsed.value;
  }
  const input = (options.input ?? 'text')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (input.some((value) => value !== 'text' && value !== 'image'))
    fail('--input accepts only text,image');
  const current = await config();
  const existing = current.models.findIndex(
    (model) => model.provider === provider && model.id === id,
  );
  if (existing >= 0 && !options.force)
    fail(`model ${provider}/${id} already exists; pass --force to overwrite`);
  const candidate = { id, provider, base_url: options.baseUrl ?? null, api_key: apiKey, input };
  const models = [...current.models];
  if (existing >= 0) models[existing] = candidate as ModelConfig;
  else models.push(candidate as ModelConfig);
  try {
    await setConfigKey('models', redactConfigRefs(models));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  if (options.json)
    emit('model.add', { status: existing >= 0 ? 'replaced' : 'added', provider, id });
  else process.stdout.write(`${existing >= 0 ? 'Replaced' : 'Added'} ${provider}/${id}.\n`);
}

async function runList(options: ModelOptions): Promise<void> {
  const current = await config();
  const profileResult = await loadProfile();
  const selected = profileResult.isOk ? profileResult.value.agent : { provider: null, model: null };
  const keychain = await createKeychainProvider();
  const available = await keychain.isAvailable();
  const accounts = new Set(
    available ? (await keychain.list(YANTRA_KEYCHAIN_SERVICE)).map((entry) => entry.account) : [],
  );
  const rows = current.models.map((model) => {
    let credential: 'env' | 'keychain' | 'absent' = 'absent';
    if (model.api_key?.kind === 'env' && process.env[model.api_key.name]) credential = 'env';
    if (model.api_key?.kind === 'secret' && accounts.has(model.api_key.key))
      credential = 'keychain';
    return {
      provider: model.provider,
      id: model.id,
      input: model.input,
      credential,
      default: selected.provider === model.provider && selected.model === model.id,
    };
  });
  if (options.json) emit('model.list', { rows });
  else
    for (const row of rows)
      process.stdout.write(
        `${row.default ? '* ' : '  '}${row.provider}/${row.id}\t${row.input.join(',')}\t${row.credential}\n`,
      );
}

async function runRemove(id: string, options: ModelOptions): Promise<void> {
  const current = await config();
  const matches = current.models.filter((model) => model.id === id);
  if (matches.length === 0) fail(`model "${id}" is not registered`);
  if (matches.length > 1) fail(`model id "${id}" is ambiguous across providers`);
  const target = matches[0]!;
  const profile = await loadProfile();
  if (
    profile.isOk &&
    profile.value.agent.provider === target.provider &&
    profile.value.agent.model === target.id &&
    !options.force
  )
    fail(`${target.provider}/${target.id} is the current default; pass --force to remove it`);
  await setConfigKey(
    'models',
    redactConfigRefs(current.models.filter((model) => model !== target)),
  );
  if (options.json) emit('model.rm', { status: 'removed', provider: target.provider, id });
  else process.stdout.write(`Removed ${target.provider}/${id}.\n`);
}

async function runDefault(id: string, options: ModelOptions): Promise<void> {
  const current = await config();
  const matches = current.models.filter((model) => model.id === id);
  if (matches.length !== 1)
    fail(
      matches.length === 0
        ? `model "${id}" is not registered`
        : `model id "${id}" is ambiguous across providers`,
    );
  const loaded = await loadProfile();
  if (!loaded.isOk) fail(loaded.error);
  const target = matches[0]!;
  await saveProfile({
    ...loaded.value,
    agent: { ...loaded.value.agent, provider: target.provider, model: target.id },
  });
  if (options.json) emit('model.default', { status: 'selected', provider: target.provider, id });
  else process.stdout.write(`Default model: ${target.provider}/${id}.\n`);
}

function emit(kind: string, body: Record<string, unknown>): void {
  process.stdout.write(
    `${JSON.stringify({ schemaVersion: CLI_JSON_SCHEMA_VERSION, kind, ...body })}\n`,
  );
}

function fail(message: string): never {
  process.stderr.write(`Error: ${message}\n`);
  throw new CommanderError(1, 'yantra.model.failed', message);
}
