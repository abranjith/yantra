import {
  ResourceBusyError,
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

import { createTerminalContext } from '../adapters/terminal/terminal-adapter.js';
import { CommandFailure, type CommandContext } from '../context/command-context.js';
import { resourceOptions } from '../context/resource-options.js';
import { createRegisteredCommand } from '../registry/build-command-tree.js';
import { handler } from '../registry/handler.js';
import { CLI_JSON_SCHEMA_VERSION } from '../render/json.js';

interface ModelOptions {
  readonly json?: boolean;
  readonly provider?: string;
  readonly baseUrl?: string;
  readonly apiKeyRef?: string;
  readonly input?: string;
  readonly force?: boolean;
}

export function makeModelCommand(context: CommandContext = createTerminalContext()): Command {
  return createRegisteredCommand('model', modelHandlers(context));
}

/** Handlers for the `model` family, bound by registry id. */
export function modelHandlers(context: CommandContext = createTerminalContext()) {
  return {
    'model.list': handler((_args, options: ModelOptions) => runList(context, options)),
    'model.add': handler((args, options: ModelOptions) =>
      runAdd(context, args[0] as string, options),
    ),
    'model.rm': handler((args, options: ModelOptions) =>
      runRemove(context, args[0] as string, options),
    ),
    'model.default': handler((args, options: ModelOptions) =>
      runDefault(context, args[0] as string, options),
    ),
  } as const;
}

async function config(context: CommandContext) {
  const loaded = await loadConfig();
  if (!loaded.isOk) fail(context, loaded.error.message);
  return loaded.value;
}

async function runAdd(context: CommandContext, id: string, options: ModelOptions): Promise<void> {
  const provider = options.provider?.trim().toLowerCase();
  if (!provider) fail(context, '--provider must not be empty');
  let apiKey = null;
  if (options.apiKeyRef) {
    const parsed = parseConfigRef(options.apiKeyRef);
    if (!parsed.isOk)
      fail(context, `${parsed.error}; use yantra secret set for literal credentials`);
    apiKey = parsed.value;
  }
  const input = (options.input ?? 'text')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (input.some((value) => value !== 'text' && value !== 'image'))
    fail(context, '--input accepts only text,image');
  let existing = -1;
  const candidate = { id, provider, base_url: options.baseUrl ?? null, api_key: apiKey, input };
  try {
    await mutateConfig(
      (current) => {
        existing = current.models.findIndex(
          (model) => model.provider === provider && model.id === id,
        );
        if (existing >= 0 && !options.force)
          fail(context, `model ${provider}/${id} already exists; pass --force to overwrite`);
        const models = [...current.models];
        if (existing >= 0) models[existing] = candidate as ModelConfig;
        else models.push(candidate as ModelConfig);
        return { ...current, models };
      },
      undefined,
      resourceOptions(context, 'model add'),
    );
  } catch (error) {
    if (error instanceof CommandFailure) throw error;

    if (error instanceof ResourceBusyError) throw error;
    if (error instanceof CommanderError) throw error;
    fail(context, error instanceof Error ? error.message : String(error));
  }
  if (options.json)
    emit(context, 'model.add', { status: existing >= 0 ? 'replaced' : 'added', provider, id });
  else context.output.stdout.write(`${existing >= 0 ? 'Replaced' : 'Added'} ${provider}/${id}.\n`);
}

async function runList(context: CommandContext, options: ModelOptions): Promise<void> {
  const current = await config(context);
  const profileResult = await loadProfile();
  const selected = profileResult.isOk ? profileResult.value.agent : { provider: null, model: null };
  const keychain = await createKeychainProvider();
  const available = await keychain.isAvailable();
  const accounts = new Set(
    available ? (await keychain.list(YANTRA_KEYCHAIN_SERVICE)).map((entry) => entry.account) : [],
  );
  const rows = current.models.map((model) => {
    let credential: 'env' | 'keychain' | 'absent' = 'absent';
    if (model.api_key?.kind === 'env' && context.settings.env()[model.api_key.name])
      credential = 'env';
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
  if (options.json) emit(context, 'model.list', { rows });
  else
    for (const row of rows)
      context.output.stdout.write(
        `${row.default ? '* ' : '  '}${row.provider}/${row.id}\t${row.input.join(',')}\t${row.credential}\n`,
      );
}

async function runRemove(
  context: CommandContext,
  id: string,
  options: ModelOptions,
): Promise<void> {
  let provider = '';
  try {
    await mutateConfig(
      async (current) => {
        const matches = current.models.filter((model) => model.id === id);
        if (matches.length === 0) fail(context, `model "${id}" is not registered`);
        if (matches.length > 1) fail(context, `model id "${id}" is ambiguous across providers`);
        const target = matches[0]!;
        const profile = await loadProfile();
        if (
          profile.isOk &&
          profile.value.agent.provider === target.provider &&
          profile.value.agent.model === target.id &&
          !options.force
        )
          fail(
            context,
            `${target.provider}/${target.id} is the current default; pass --force to remove it`,
          );
        provider = target.provider;
        return { ...current, models: current.models.filter((model) => model !== target) };
      },
      undefined,
      resourceOptions(context, 'model rm'),
    );
  } catch (error) {
    if (error instanceof CommandFailure) throw error;

    if (error instanceof ResourceBusyError) throw error;
    if (error instanceof CommanderError) throw error;
    fail(context, error instanceof Error ? error.message : String(error));
  }
  if (options.json) emit(context, 'model.rm', { status: 'removed', provider, id });
  else context.output.stdout.write(`Removed ${provider}/${id}.\n`);
}

async function runDefault(
  context: CommandContext,
  id: string,
  options: ModelOptions,
): Promise<void> {
  const current = await config(context);
  const matches = current.models.filter((model) => model.id === id);
  if (matches.length !== 1)
    fail(
      context,
      matches.length === 0
        ? `model "${id}" is not registered`
        : `model id "${id}" is ambiguous across providers`,
    );
  const target = matches[0]!;
  try {
    await mutateProfile(
      (current) => ({
        ...current,
        agent: { ...current.agent, provider: target.provider, model: target.id },
      }),
      undefined,
      resourceOptions(context, 'model default'),
    );
  } catch (error) {
    if (error instanceof CommandFailure) throw error;

    if (error instanceof ResourceBusyError) throw error;
    fail(context, error instanceof Error ? error.message : String(error));
  }
  if (options.json)
    emit(context, 'model.default', { status: 'selected', provider: target.provider, id });
  else context.output.stdout.write(`Default model: ${target.provider}/${id}.\n`);
}

function emit(context: CommandContext, kind: string, body: Record<string, unknown>): void {
  context.output.json({ schemaVersion: CLI_JSON_SCHEMA_VERSION, kind, ...body });
}

function fail(context: CommandContext, message: string): never {
  context.output.stderr.write(`Error: ${message}\n`);
  throw new CommanderError(1, 'yantra.model.failed', message);
}
