import {
  createKeychainProvider,
  loadConfig,
  loadProfile,
  parseConfigRef,
  mutateConfig,
  mutateProfile,
  YANTRA_KEYCHAIN_SERVICE,
  type ModelConfig,
} from '@yantra/core';
import { type Command, CommanderError } from 'commander';

import { createRegisteredCommand } from '../registry/build-command-tree.js';
import { handler } from '../registry/handler.js';
import { CLI_JSON_SCHEMA_VERSION } from '../render/json.js';
import { throwIfResourceBusy } from '../resource-busy.js';

interface ModelOptions {
  readonly json?: boolean;
  readonly provider?: string;
  readonly baseUrl?: string;
  readonly apiKeyRef?: string;
  readonly input?: string;
  readonly force?: boolean;
}

export function makeModelCommand(): Command {
  return createRegisteredCommand('model', modelHandlers());
}

/** Handlers for the `model` family, bound by registry id. */
export function modelHandlers() {
  return {
    'model.list': handler((_args, options: ModelOptions) => runList(options)),
    'model.add': handler((args, options: ModelOptions) => runAdd(args[0] as string, options)),
    'model.rm': handler((args, options: ModelOptions) => runRemove(args[0] as string, options)),
    'model.default': handler((args, options: ModelOptions) =>
      runDefault(args[0] as string, options),
    ),
  } as const;
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
  let existing = -1;
  const candidate = { id, provider, base_url: options.baseUrl ?? null, api_key: apiKey, input };
  try {
    await mutateConfig((current) => {
      existing = current.models.findIndex(
        (model) => model.provider === provider && model.id === id,
      );
      if (existing >= 0 && !options.force)
        fail(`model ${provider}/${id} already exists; pass --force to overwrite`);
      const models = [...current.models];
      if (existing >= 0) models[existing] = candidate as ModelConfig;
      else models.push(candidate as ModelConfig);
      return { ...current, models };
    });
  } catch (error) {
    throwIfResourceBusy(error, 'model.add', options.json === true, process);
    if (error instanceof CommanderError) throw error;
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
  let provider = '';
  try {
    await mutateConfig(async (current) => {
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
      provider = target.provider;
      return { ...current, models: current.models.filter((model) => model !== target) };
    });
  } catch (error) {
    throwIfResourceBusy(error, 'model.rm', options.json === true, process);
    if (error instanceof CommanderError) throw error;
    fail(error instanceof Error ? error.message : String(error));
  }
  if (options.json) emit('model.rm', { status: 'removed', provider, id });
  else process.stdout.write(`Removed ${provider}/${id}.\n`);
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
  const target = matches[0]!;
  try {
    await mutateProfile((current) => ({
      ...current,
      agent: { ...current.agent, provider: target.provider, model: target.id },
    }));
  } catch (error) {
    throwIfResourceBusy(error, 'model.default', options.json === true, process);
    fail(error instanceof Error ? error.message : String(error));
  }
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
