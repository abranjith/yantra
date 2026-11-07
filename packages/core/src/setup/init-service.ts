/** Shared initialization policy and portable answer collection. No terminal or provider SDK. */
import { mkdir, rename, stat } from 'node:fs/promises';
import { dirname, isAbsolute, win32 } from 'node:path';

import { stringify } from 'yaml';

import { configPath } from '../browser/paths.js';
import { defaultConfig } from '../config/load.js';
import { parseConfigRef, redactConfigRefs, type ConfigRef } from '../config/refs.js';
import type { YantraConfig } from '../config/schema.js';
import { writeConfigDocument } from '../config/write.js';
import { ResourceBusyError, type ResourceLockOptions } from '../locks/resource-lock.js';
import type { AmbientGrants } from '../profile/ambient-context.js';
import { defaultProfile, profilePath, mutateProfile } from '../profile/profile-file.js';
import {
  createKeychainProvider,
  YANTRA_KEYCHAIN_SERVICE,
  type KeychainProvider,
} from '../secrets/keychain.js';
export interface InitAnswers {
  readonly provider: 'anthropic' | 'ollama' | 'none';
  readonly modelId: string | null;
  readonly baseUrl: string | null;
  readonly apiKey: ConfigRef | null;
  readonly dataDir: string | null;
  /** What the optional search-key step did (FEAT-050). */
  readonly searchKey: SearchKeyOutcome;
}

/** The keyed search providers `init` offers to store a key for. */
export type KeyedSearchProvider = 'tavily' | 'brave';

/**
 * The optional search-key step's outcome: nothing stored, a key stored in the
 * keychain, or — when the keychain is unavailable — the command the user can
 * run later instead. The step never fails `init`.
 */
export type SearchKeyOutcome =
  | { readonly status: 'skipped' }
  | { readonly status: 'stored'; readonly provider: KeyedSearchProvider }
  | { readonly status: 'manual'; readonly provider: KeyedSearchProvider; readonly command: string };

export interface InitProviderInput {
  readonly select: (message: string, choices: readonly string[]) => Promise<string | null>;
  readonly text: (message: string, initial?: string) => Promise<string | null>;
  readonly password: (message: string) => Promise<string | null>;
  /** The OS keychain secrets are stored in; injectable for tests. */
  readonly keychain?: () => Promise<KeychainProvider>;
}

export async function collectInitProviderAnswers(deps: InitProviderInput): Promise<InitAnswers> {
  const select = deps.select;
  const text = deps.text;
  const password = deps.password;
  const keychain = deps.keychain ?? createKeychainProvider;
  const provider = normalizeProvider(
    await select('Model provider', ['anthropic', 'ollama', 'none']),
  );
  if (provider === 'none') {
    const searchKey = await searchKeyStep(select, password, keychain);
    return {
      provider,
      modelId: null,
      baseUrl: null,
      apiKey: null,
      dataDir: await storage(text),
      searchKey,
    };
  }

  const credentialMode =
    (await select('Credential source', ['environment variable', 'keychain', 'skip'])) ?? 'skip';
  let apiKey: ConfigRef | null = null;
  if (credentialMode === 'environment variable') {
    const defaultName = provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OLLAMA_API_KEY';
    const name =
      nonEmpty((await text('Environment variable name', defaultName))?.trim()) ?? defaultName;
    const parsed = parseConfigRef(`\${env:${name}}`);
    if (!parsed.isOk) throw new Error(parsed.error);
    apiKey = parsed.value;
  } else if (credentialMode === 'keychain') {
    const key = `${provider}.api_key`;
    const value = await password(`Secret value for ${key}`);
    if (value) {
      const store = await keychain();
      if (!(await store.isAvailable()))
        throw new Error(
          'OS keychain is unavailable; choose an environment-variable reference instead',
        );
      await store.set(YANTRA_KEYCHAIN_SERVICE, key, value);
      const parsed = parseConfigRef(`\${secret:${key}}`);
      if (!parsed.isOk) throw new Error(parsed.error);
      apiKey = parsed.value;
    }
  }
  const defaultModel = provider === 'anthropic' ? 'claude-opus-4-7' : 'llama3.1:8b';
  const modelId = nonEmpty((await text('Model id', defaultModel))?.trim()) ?? defaultModel;
  const baseUrl =
    provider === 'ollama'
      ? (nonEmpty((await text('Ollama base URL', 'http://localhost:11434'))?.trim()) ??
        'http://localhost:11434')
      : null;
  const searchKey = await searchKeyStep(select, password, keychain);
  return { provider, modelId, baseUrl, apiKey, dataDir: await storage(text), searchKey };
}

/**
 * Offer to store a keyed search provider's API key (FEAT-050). Without one,
 * web search scrapes a results page, which Yantra serializes and stops at the
 * first challenge. Same password prompt and keychain account convention as the
 * model step (`<provider>.api_key`). An unavailable keychain does not fail
 * `init`: the outcome carries the `yantra secret set` command to run later.
 */
async function searchKeyStep(
  select: NonNullable<InitProviderInput['select']>,
  password: NonNullable<InitProviderInput['password']>,
  keychain: NonNullable<InitProviderInput['keychain']>,
): Promise<SearchKeyOutcome> {
  const choice = await select('Search provider key (optional)', ['tavily', 'brave', 'skip']);
  if (choice !== 'tavily' && choice !== 'brave') return { status: 'skipped' };
  const account = `${choice}.api_key`;
  const value = await password(`Secret value for ${account}`);
  if (!value) return { status: 'skipped' };
  const manual: SearchKeyOutcome = {
    status: 'manual',
    provider: choice,
    command: `yantra secret set ${account}`,
  };
  let store: KeychainProvider;
  try {
    store = await keychain();
  } catch {
    // swallow-ok: an unavailable keychain is reported through the manual command.
    return manual;
  }
  if (!(await store.isAvailable())) return manual;
  await store.set(YANTRA_KEYCHAIN_SERVICE, account, value);
  return { status: 'stored', provider: choice };
}

async function storage(text: NonNullable<InitProviderInput['text']>): Promise<string | null> {
  const value = (await text('Data directory (blank for ~/.yantra/data)'))?.trim();
  return nonEmpty(value) ?? null;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

function normalizeProvider(value: string | null): InitAnswers['provider'] {
  return value === 'anthropic' || value === 'ollama' ? value : 'none';
}

export interface ContextGrantAnswers {
  /** The user's grants over sensitive ambient facts. */
  readonly grants: AmbientGrants;
  /** The location value, or `null` when not granted or left blank. */
  readonly city: string | null;
}

/** Injectable boundaries for deterministic questionnaire tests. */
export interface ContextGrantDeps {
  /** Asks a yes/no question; `null` means the user cancelled. */
  readonly confirm?: (message: string) => Promise<boolean | null>;
  /** Asks a free-text question; `null` means cancelled, `''` means skipped. */
  readonly text?: (message: string) => Promise<string | null>;
}

const LOCATION_QUESTION =
  'Share your location with the agent? Without it, Yantra will ask you to name a ' +
  "location in queries like 'hotels near me' rather than guessing one.";

const CITY_QUESTION = 'City or area (e.g. Naperville, IL) — leave blank to set later';

/** The behavior-preserving answers used when prompting is skipped or cancelled. */
export function defaultContextGrantAnswers(): ContextGrantAnswers {
  return { grants: { location: true, screenshots: false }, city: null };
}

/**
 * Runs the grant questionnaire.
 *
 * Declining the location grant skips the city question entirely — asking for a
 * value the user just refused to share would be both pointless and hostile.
 *
 * @param deps - Injectable prompt boundaries; defaults to the real terminal.
 * @returns The collected grants and city, or the defaults on cancellation.
 */
export async function collectInitContextGrants(
  deps: Required<ContextGrantDeps>,
): Promise<ContextGrantAnswers> {
  const confirm = deps.confirm;
  const text = deps.text;

  const shareLocation = await confirm(LOCATION_QUESTION);
  if (shareLocation === null) {
    return defaultContextGrantAnswers();
  }
  if (!shareLocation) {
    return { grants: { location: false, screenshots: false }, city: null };
  }

  const city = await text(CITY_QUESTION);
  const trimmed = city === null ? '' : city.trim();
  return {
    grants: { location: true, screenshots: false },
    city: trimmed.length > 0 ? trimmed : null,
  };
}

export function defaultsFor(provider: InitAnswers['provider']): InitAnswers {
  if (provider === 'anthropic')
    return {
      provider,
      modelId: 'claude-opus-4-7',
      baseUrl: null,
      apiKey: { kind: 'env', name: 'ANTHROPIC_API_KEY' },
      dataDir: null,
      searchKey: { status: 'skipped' },
    };
  if (provider === 'ollama')
    return {
      provider,
      modelId: 'llama3.1:8b',
      baseUrl: 'http://localhost:11434',
      apiKey: null,
      dataDir: null,
      searchKey: { status: 'skipped' },
    };
  return {
    provider: 'none',
    modelId: null,
    baseUrl: null,
    apiKey: null,
    dataDir: null,
    searchKey: { status: 'skipped' },
  };
}

function buildConfig(answers: InitAnswers): YantraConfig {
  const base = defaultConfig();
  return {
    ...base,
    paths: { ...base.paths, data_dir: answers.dataDir },
    models:
      answers.provider === 'none' || !answers.modelId
        ? []
        : [
            {
              id: answers.modelId,
              provider: answers.provider,
              base_url: answers.baseUrl,
              api_key: answers.apiKey,
              input: ['text'],
            },
          ],
  };
}

function serializable(config: YantraConfig): unknown {
  const raw = redactConfigRefs(config) as Record<string, unknown>;
  const models = (raw.models as Record<string, unknown>[]).map((model) =>
    Object.fromEntries(
      Object.entries(model).filter(
        ([key, value]) => !((key === 'api_key' || key === 'base_url') && value === null),
      ),
    ),
  );
  return { ...raw, models };
}

export interface InitAnswerCollector {
  providerAnswers(): Promise<InitAnswers>;
  contextGrants(): Promise<ContextGrantAnswers>;
}
export interface InitRequest {
  readonly provider?: string;
  readonly reset: boolean;
  readonly yes: boolean;
  readonly interactive: boolean;
}
export interface InitServiceDependencies {
  readonly configPath?: string;
  readonly profilePath?: string;
  readonly now?: () => number;
  readonly lockOptions?: ResourceLockOptions;
}
export type InitResult =
  | { readonly status: 'already-initialized'; readonly configPath: string }
  | { readonly status: 'invalid-provider'; readonly provider: string }
  | { readonly status: 'failed'; readonly message: string }
  | {
      readonly status: 'written';
      readonly configPath: string;
      readonly profilePath: string;
      readonly writingProfile: boolean;
      readonly provider: InitAnswers['provider'];
      readonly searchKey: SearchKeyOutcome;
      readonly grants: ContextGrantAnswers;
    };

/** Initialize through the same locked configuration/profile writers as normal mutations. */
export async function runInit(
  request: InitRequest,
  collector: InitAnswerCollector,
  deps: InitServiceDependencies = {},
): Promise<InitResult> {
  try {
    const target = deps.configPath ?? configPath();
    const profileTarget = deps.profilePath ?? profilePath();
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    if ((await fileExists(target)) && !request.reset)
      return { status: 'already-initialized', configPath: target };
    const provider = (request.provider ?? 'none').toLowerCase();
    if (!['anthropic', 'ollama', 'none'].includes(provider))
      return { status: 'invalid-provider', provider };
    const interactive = request.interactive && !request.yes;
    const answers =
      interactive && request.provider === undefined
        ? await collector.providerAnswers()
        : defaultsFor(provider as InitAnswers['provider']);
    if (answers.dataDir && !(isAbsolute(answers.dataDir) || win32.isAbsolute(answers.dataDir)))
      throw new Error('the data directory must be absolute');
    if (answers.dataDir) await mkdir(answers.dataDir, { recursive: true, mode: 0o700 });
    let alreadyInitialized = false;
    await writeConfigDocument(stringify(serializable(buildConfig(answers))), target, {
      ...deps.lockOptions,
      beforeWrite: async () => {
        if (await fileExists(target)) {
          if (!request.reset) {
            alreadyInitialized = true;
            return false;
          }
          await rename(target, `${target}.bak.${(deps.now ?? Date.now)()}`);
        }
        return true;
      },
    });
    if (alreadyInitialized) return { status: 'already-initialized', configPath: target };
    let writingProfile = request.reset || !(await fileExists(profileTarget));
    let grants = defaultContextGrantAnswers();
    if (writingProfile) {
      if (interactive) grants = await collector.contextGrants();
      await mutateProfile(
        async (current) => {
          if (!request.reset && (await fileExists(profileTarget))) {
            writingProfile = false;
            return current;
          }
          const profile = defaultProfile();
          return {
            ...profile,
            locale: { ...profile.locale, city: grants.city },
            context: { ...profile.context, location: grants.grants.location },
            agent: {
              ...profile.agent,
              provider: answers.provider === 'none' ? null : answers.provider,
              model: answers.modelId,
            },
          };
        },
        profileTarget,
        deps.lockOptions,
      );
    }
    return {
      status: 'written',
      configPath: target,
      profilePath: profileTarget,
      writingProfile,
      provider: answers.provider,
      searchKey: answers.searchKey,
      grants,
    };
  } catch (error) {
    if (error instanceof ResourceBusyError) throw error;
    return { status: 'failed', message: error instanceof Error ? error.message : String(error) };
  }
}
async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
