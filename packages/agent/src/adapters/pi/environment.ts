/**
 * Yantra-owned Pi runtime environment (FEAT-022 TASK-003, plan §4/§8.11).
 *
 * Every Pi path is pinned under the Yantra data directory and settings are
 * supplied in-memory — the user's interactive `~/.pi` installation and any
 * project-local `.pi/settings.json` are never consulted. The resource loader
 * is fully controlled: it returns exactly the caller-supplied system prompt
 * and zero extensions, skills, prompt templates, themes, and context files.
 *
 * Pointing `managed` auth at an existing personal pi `auth.json` is an
 * explicit, documented config opt-in (`agent.pi_auth_path` in
 * `~/.config/yantra/config.yaml`), never a default.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  AuthStorage,
  DefaultResourceLoader,
  ModelRegistry,
  SettingsManager,
  type ResourceLoader,
} from '@earendil-works/pi-coding-agent';
import {
  createKeychainProvider,
  dataDir as yantraDataDir,
  loadConfig,
  type KeychainProvider,
  type YantraConfig,
} from '@yantra/core';
import pino from 'pino';

import { AgentAuthUnavailableError } from '../../errors.js';
import type { AgentAuthSelection } from '../../provider/types.js';

import { projectModels } from './model-projection.js';

const logger = pino({ name: 'pi-environment', level: process.env.LOG_LEVEL ?? 'info' });

/**
 * Projects the registered models onto the pinned `models.json`.
 *
 * `models.json` is derived state: `config.yaml`'s `models:` block is the only
 * source of truth, so the projection replaces the file rather than merging.
 * An unreadable config leaves the existing file untouched — a malformed
 * `config.yaml` must not erase a working registry.
 *
 * @param config Explicit installation config, or `undefined` to load the ambient one.
 * @param modelsPath Pinned models.json path (never the ambient `~/.pi` copy).
 */
async function projectRegisteredModels(
  config: YantraConfig | undefined,
  modelsPath: string,
): Promise<void> {
  if (config) {
    await projectModels(config, modelsPath);
    return;
  }
  const loaded = await loadConfig();
  if (loaded.isOk) await projectModels(loaded.value, modelsPath);
}

/**
 * Where the credential that will authenticate the session came from.
 * Recorded by FEAT-023 as the manifest `auth_source` field.
 */
export type PiAuthSource =
  | 'managed'
  | 'runtime-key'
  | 'environment'
  | 'models-config'
  | 'unavailable';

/** Options for {@link createPiEnvironment}. */
export interface PiEnvironmentOptions {
  /** Working directory recorded for the session. Never used for resource discovery. */
  readonly cwd: string;
  /** The complete system prompt — the only prompt source the loader yields. */
  readonly systemPrompt: string;
  /** Model provider key (e.g. `anthropic`); used for auth resolution and status. */
  readonly provider: string;
  /** Model credential selection (managed store vs. runtime-only key). */
  readonly auth: AgentAuthSelection;
  /**
   * Base data directory override. Defaults to the Yantra data dir; tests
   * inject a temp dir so every constructed path stays inside the sandbox.
   */
  readonly dataDir?: string;
  /**
   * Installation config the pinned `models.json` is projected from. Defaults
   * to the ambient `config.yaml`; injected alongside `dataDir` so a sandboxed
   * environment never projects the developer's real model registry into a
   * temp dir.
   */
  readonly config?: YantraConfig;
  /**
   * Explicit opt-in (config key `agent.pi_auth_path`): absolute path to an
   * existing personal pi `auth.json` to use for `managed` auth. Affects the
   * auth path ONLY — settings, models, and sessions stay pinned.
   */
  readonly personalPiAuthPath?: string;
  /**
   * Resolves a Yantra `SecretRef` to its live value. Required when
   * `auth.mode === 'runtime-key'`. The resolved value is handed to Pi's
   * runtime-only key override and is never persisted or logged.
   */
  readonly resolveSecret?: (secretRef: string) => Promise<string>;
}

/** Effective paths and resources of a constructed environment (enumeration test + diagnostics). */
export interface PiEnvironmentEnumeration {
  readonly agentDir: string;
  readonly authPath: string;
  readonly modelsPath: string;
  readonly sessionStagingDir: string;
  /** Settings never come from disk. */
  readonly settingsSource: 'in-memory';
  readonly systemPrompt: string | undefined;
  readonly appendSystemPrompt: readonly string[];
  readonly extensions: readonly string[];
  readonly skills: readonly string[];
  readonly prompts: readonly string[];
  readonly themes: readonly string[];
  readonly contextFiles: readonly string[];
}

/** A fully constructed, pinned Pi runtime environment. */
export interface PiEnvironment {
  /** Pinned Pi config root: `<yantra-data-dir>/pi`. */
  readonly agentDir: string;
  /** Effective credentials file (pinned, or the documented personal-store opt-in). */
  readonly authPath: string;
  /** Pinned custom/local model definitions (Ollama etc.). */
  readonly modelsPath: string;
  /** Pinned staging directory for sessions not yet placed under a run. */
  readonly sessionStagingDir: string;
  readonly authStorage: AuthStorage;
  readonly modelRegistry: ModelRegistry;
  readonly settingsManager: SettingsManager;
  readonly resourceLoader: ResourceLoader;
  /** Which credential source will authenticate this session (for the run manifest). */
  readonly authSource: PiAuthSource;
  /** Enumerate effective paths/resources — the §8 enforcement surface. */
  enumerate(): PiEnvironmentEnumeration;
}

/** Offline credential-presence result; never contains credential material. */
export interface PiCredentialProbe {
  readonly available: boolean;
  readonly authSource: PiAuthSource;
}

/** Minimal registry seam used by the pre-catalog image-capability probe. */
export interface ModelLookup {
  find(provider: string, modelId: string): unknown;
}

/**
 * Resolves whether the selected Pi model explicitly declares image input.
 * Registry misses and malformed declarations fail closed.
 */
export async function modelSupportsImageInput(
  provider: string,
  modelId: string,
  lookup?: ModelLookup,
): Promise<boolean> {
  try {
    const modelsPath = join(yantraDataDir(), 'pi', 'models.json');
    if (!lookup) await projectRegisteredModels(undefined, modelsPath);
    const registry =
      lookup ??
      ModelRegistry.create(
        AuthStorage.create(join(yantraDataDir(), 'pi', 'auth.json')),
        modelsPath,
      );
    const model = registry.find(provider, modelId) as { input?: unknown } | undefined;
    return Array.isArray(model?.input) && model.input.includes('image');
  } catch {
    return false;
  }
}

/** Inputs for {@link probePiCredential}. */
export interface PiCredentialProbeOptions {
  readonly provider: string;
  readonly auth: AgentAuthSelection;
  readonly env?: NodeJS.ProcessEnv;
  readonly dataDir?: string;
  /** See {@link PiEnvironmentOptions.config}. */
  readonly config?: YantraConfig;
  readonly personalPiAuthPath?: string;
  readonly keychain?: KeychainProvider;
}

/**
 * Checks whether the selected credential source exists without opening a
 * provider session or reading a secret value into Yantra code. Runtime-key
 * references are checked through keychain account enumeration; managed,
 * environment, and models-config sources use Pi's status-only registry API.
 * Any unreadable source is treated as unavailable.
 */
export async function probePiCredential(
  options: PiCredentialProbeOptions,
): Promise<PiCredentialProbe> {
  try {
    if (options.auth.mode === 'runtime-key') {
      const { secretRef } = options.auth;
      const keychain = options.keychain ?? (await createKeychainProvider());
      const entries = await keychain.list('yantra');
      const available = entries.some((entry) => entry.account === secretRef);
      return { available, authSource: available ? 'runtime-key' : 'unavailable' };
    }

    const env = options.env ?? process.env;
    if (providerEnvironmentCredential(options.provider, env)) {
      return { available: true, authSource: 'environment' };
    }

    const baseDataDir = options.dataDir ?? yantraDataDir();
    const agentDir = join(baseDataDir, 'pi');
    const authPath = options.personalPiAuthPath ?? join(agentDir, 'auth.json');
    const modelsPath = join(agentDir, 'models.json');
    await projectRegisteredModels(options.config, modelsPath);
    const authStorage = AuthStorage.create(authPath);
    const registry = ModelRegistry.create(authStorage, modelsPath);
    const status = registry.getProviderAuthStatus(options.provider);

    if (status.source === 'stored' || (status.configured && status.source === undefined)) {
      return { available: true, authSource: 'managed' };
    }
    if (status.source === 'models_json_key' || status.source === 'models_json_command') {
      return { available: true, authSource: 'models-config' };
    }
    // Pi consults the real process environment internally. Only report that
    // source when it also exists in the caller-supplied environment, keeping
    // injected diagnostic/test environments hermetic.
    if (
      (status.source === 'environment' || status.source === 'fallback') &&
      providerEnvironmentCredential(options.provider, env)
    ) {
      return { available: true, authSource: 'environment' };
    }
  } catch {
    // Presence probing is deliberately best-effort.
  }
  return { available: false, authSource: 'unavailable' };
}

/**
 * Build a pinned, Yantra-owned Pi environment.
 *
 * @param options See {@link PiEnvironmentOptions}.
 * @returns The constructed environment with auth storage, model registry,
 *   in-memory settings, and a controlled resource loader (already reloaded).
 * @throws AgentAuthUnavailableError when `runtime-key` auth is requested but
 *   no secret resolver is configured or the reference cannot be resolved.
 *
 * Side effects: creates the pinned agentDir (and `auth.json`) on first use.
 * The resolved runtime key is applied via Pi's in-memory override and is
 * never written to disk or logged.
 */
export async function createPiEnvironment(options: PiEnvironmentOptions): Promise<PiEnvironment> {
  const baseDataDir = options.dataDir ?? yantraDataDir();
  const agentDir = join(baseDataDir, 'pi');
  const authPath = options.personalPiAuthPath ?? join(agentDir, 'auth.json');
  const modelsPath = join(agentDir, 'models.json');
  const sessionStagingDir = join(agentDir, 'sessions');

  await projectRegisteredModels(options.config, modelsPath);
  const authStorage = AuthStorage.create(authPath);
  const modelRegistry = ModelRegistry.create(authStorage, modelsPath);

  if (options.auth.mode === 'runtime-key') {
    const { secretRef } = options.auth;
    if (options.resolveSecret === undefined) {
      throw new AgentAuthUnavailableError(
        options.provider,
        `runtime-key secret reference "${secretRef}"`,
        'No secret resolver is configured for runtime-key auth; wire one at startup or use managed auth.',
      );
    }
    let resolved: string;
    try {
      resolved = await options.resolveSecret(secretRef);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new AgentAuthUnavailableError(
        options.provider,
        `runtime-key secret reference "${secretRef}"`,
        `The secret reference could not be resolved (${reason}). Seed it in the OS keychain or switch to managed auth.`,
      );
    }
    // Runtime-only override: Pi holds the key in memory and never persists it.
    authStorage.setRuntimeApiKey(options.provider, resolved);
  }

  // Settings are in-memory with pinned overrides (plan §9: auto-compaction
  // stays enabled with adapter-pinned settings; no user/project Pi settings
  // can influence a Yantra session). No resource paths or packages are set,
  // so nothing ambient is discoverable even before the no-* flags below.
  const settingsManager = SettingsManager.inMemory(
    {
      compaction: { enabled: true },
      defaultProjectTrust: 'never',
      enableAnalytics: false,
      enableInstallTelemetry: false,
      enableSkillCommands: false,
      quietStartup: true,
      sessionDir: sessionStagingDir,
    },
    { projectTrusted: false },
  );

  const resourceLoader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: options.systemPrompt,
    // Belt and braces: even if a discovery path slips past the no-* flags,
    // the overrides force the caller-supplied prompt and nothing else.
    systemPromptOverride: () => options.systemPrompt,
    appendSystemPromptOverride: () => [],
  });
  await resourceLoader.reload();

  const authSource = resolveAuthSource(modelRegistry, options.provider);

  logger.debug(
    { agentDir, authPath, modelsPath, sessionStagingDir, authSource },
    'pi environment constructed against pinned paths',
  );

  const enumerate = (): PiEnvironmentEnumeration => ({
    agentDir,
    authPath,
    modelsPath,
    sessionStagingDir,
    settingsSource: 'in-memory',
    systemPrompt: resourceLoader.getSystemPrompt(),
    appendSystemPrompt: resourceLoader.getAppendSystemPrompt(),
    extensions: resourceLoader.getExtensions().extensions.map((extension) => extension.path),
    skills: resourceLoader.getSkills().skills.map((skill) => skill.name),
    prompts: resourceLoader.getPrompts().prompts.map((prompt) => prompt.name),
    themes: resourceLoader
      .getThemes()
      .themes.map((theme) => theme.name ?? theme.sourcePath ?? 'unnamed'),
    contextFiles: resourceLoader.getAgentsFiles().agentsFiles.map((file) => file.path),
  });

  return {
    agentDir,
    authPath,
    modelsPath,
    sessionStagingDir,
    authStorage,
    modelRegistry,
    settingsManager,
    resourceLoader,
    authSource,
    enumerate,
  };
}

/** The context window Pi assumes for custom models that do not declare one. */
export const PI_DEFAULT_CUSTOM_CONTEXT_WINDOW = 128000;

/** Outcome of inspecting the raw models.json declaration for one model. */
export type CustomModelContextCheck =
  | { readonly kind: 'not-custom' }
  | { readonly kind: 'declared'; readonly contextWindow: number }
  | { readonly kind: 'undeclared' };

/**
 * Reports whether a models.json custom model declares its real context window.
 *
 * Pi assigns undeclared custom models a {@link PI_DEFAULT_CUSTOM_CONTEXT_WINDOW}
 * window, so compaction never engages for small local models. When the serving
 * runtime enforces a smaller window (for example Ollama's default `num_ctx` of
 * 4096), it silently truncates the prompt from the front — dropping the system
 * prompt, goal, and tool definitions — and the agent derails mid-task. Callers
 * use `undeclared` to warn actionably at session open.
 *
 * @param modelsPath Pinned models.json path (never the ambient `~/.pi` copy).
 * @param provider Provider key to look up (e.g. `ollama`).
 * @param modelId Model identifier within that provider.
 * @returns `not-custom` when the file, provider, or model is absent or
 *   unreadable; otherwise whether `contextWindow` is declared.
 */
export async function checkCustomModelContextWindow(
  modelsPath: string,
  provider: string,
  modelId: string,
): Promise<CustomModelContextCheck> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(modelsPath, 'utf8'));
  } catch {
    return { kind: 'not-custom' };
  }
  const providers = (parsed as { providers?: unknown } | null)?.providers;
  if (typeof providers !== 'object' || providers === null) return { kind: 'not-custom' };
  const entry = (providers as Record<string, unknown>)[provider];
  if (typeof entry !== 'object' || entry === null) return { kind: 'not-custom' };
  const models = (entry as { models?: unknown }).models;
  if (!Array.isArray(models)) return { kind: 'not-custom' };
  const model = models.find(
    (candidate: unknown): candidate is Record<string, unknown> =>
      typeof candidate === 'object' &&
      candidate !== null &&
      (candidate as Record<string, unknown>).id === modelId,
  );
  if (model === undefined) return { kind: 'not-custom' };
  const contextWindow = model.contextWindow;
  return typeof contextWindow === 'number' && contextWindow > 0
    ? { kind: 'declared', contextWindow }
    : { kind: 'undeclared' };
}

/** True when the provider's documented environment credential is present. */
function providerEnvironmentCredential(provider: string, env: NodeJS.ProcessEnv): boolean {
  const normalized = provider
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/gu, '_');
  const candidates = new Set<string>([`${normalized}_API_KEY`]);
  if (provider === 'anthropic') candidates.add('ANTHROPIC_API_KEY');
  if (provider === 'openai') candidates.add('OPENAI_API_KEY');
  if (provider === 'google' || provider === 'gemini' || provider === 'google-gemini') {
    candidates.add('GOOGLE_API_KEY');
    candidates.add('GEMINI_API_KEY');
  }
  return [...candidates].some((key) => {
    const value = env[key];
    return typeof value === 'string' && value.trim().length > 0;
  });
}

/**
 * Normalize Pi's credential-source vocabulary onto Yantra's audit vocabulary.
 * Environment-variable keys flow through AuthStorage's native resolution and
 * surface here as `environment` so the credential origin stays auditable.
 *
 * Pi quirk: `AuthStatus.configured` is true only for credentials stored in
 * `auth.json`; runtime and environment keys report `configured: false` but
 * carry a `source`. A present `source` therefore means a usable credential
 * path exists.
 */
function resolveAuthSource(modelRegistry: ModelRegistry, provider: string): PiAuthSource {
  const status = modelRegistry.getProviderAuthStatus(provider);
  switch (status.source) {
    case 'runtime':
      return 'runtime-key';
    case 'stored':
      return 'managed';
    case 'environment':
    case 'fallback':
      return 'environment';
    case 'models_json_key':
    case 'models_json_command':
      return 'models-config';
    default:
      // No labeled source: only a stored credential still counts.
      return status.configured ? 'managed' : 'unavailable';
  }
}
