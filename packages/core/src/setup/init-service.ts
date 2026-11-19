/** Shared initialization policy and portable answer collection. No terminal or provider SDK. */
import { mkdir, rename, stat } from 'node:fs/promises';
import { dirname, isAbsolute, win32 } from 'node:path';

import {
  INIT_QUESTIONS,
  evaluateWhen,
  resolveQuestionInitial,
  resolveQuestionMessage,
  type InitAnswerScalar,
  type InitQuestion,
  type InitQuestionId,
} from '@yantra/protocol';
import { stringify } from 'yaml';

import { configPath } from '../browser/paths.js';
import { defaultConfig } from '../config/load.js';
import { parseConfigRef, redactConfigRefs, type ConfigRef } from '../config/refs.js';
import type { YantraConfig } from '../config/schema.js';
import { writeConfigDocument } from '../config/write.js';
import { ResourceBusyError, type ResourceLockOptions } from '../locks/resource-lock.js';
import type { AmbientGrants } from '../profile/ambient-context.js';
import { defaultProfile, profilePath, mutateProfile } from '../profile/profile-file.js';
import { CREDENTIAL_MAX_BYTES } from '../secrets/credential-service.js';
import { KeychainUnavailableError } from '../secrets/errors.js';
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

  const collected: Partial<Record<InitQuestionId, InitAnswerScalar>> = {};
  let provider: InitAnswers['provider'] = 'none';
  let modelId: string | null = null;
  let baseUrl: string | null = null;
  let apiKey: ConfigRef | null = null;
  let dataDir: string | null = null;
  let searchKey: SearchKeyOutcome = { status: 'skipped' };

  for (const question of INIT_QUESTIONS) {
    if (question.section === 'context' || !evaluateWhen(question, collected)) continue;
    const message = resolveQuestionMessage(question, collected);

    switch (question.id) {
      case 'provider': {
        provider = normalizeProvider(await select(message, question.choices ?? []));
        collected.provider = provider;
        break;
      }
      case 'credential_source': {
        const mode = (await select(message, question.choices ?? [])) ?? 'skip';
        collected.credential_source = mode;
        break;
      }
      case 'credential_env_name': {
        const defaultName = resolveQuestionInitial(question, collected) ?? 'ANTHROPIC_API_KEY';
        const name = nonEmpty((await text(message, defaultName))?.trim()) ?? defaultName;
        const parsed = parseConfigRef(`\${env:${name}}`);
        if (!parsed.isOk) throw new Error(parsed.error);
        apiKey = parsed.value;
        collected.credential_env_name = name;
        break;
      }
      case 'credential_secret': {
        const key = `${provider}.api_key`;
        const value = await password(message);
        if (value) {
          const store = await keychain();
          if (!(await store.isAvailable()))
            throw new KeychainUnavailableError(
              'OS keychain is unavailable; choose an environment-variable reference instead',
              { operation: 'set' },
            );
          await store.set(YANTRA_KEYCHAIN_SERVICE, key, value);
          const parsed = parseConfigRef(`\${secret:${key}}`);
          if (!parsed.isOk) throw new Error(parsed.error);
          apiKey = parsed.value;
        }
        break;
      }
      case 'model_id': {
        const defaultModel = resolveQuestionInitial(question, collected) ?? 'claude-opus-4-7';
        modelId = nonEmpty((await text(message, defaultModel))?.trim()) ?? defaultModel;
        collected.model_id = modelId;
        break;
      }
      case 'ollama_base_url': {
        const defaultUrl = resolveQuestionInitial(question, collected) ?? 'http://localhost:11434';
        baseUrl = nonEmpty((await text(message, defaultUrl))?.trim()) ?? defaultUrl;
        collected.ollama_base_url = baseUrl;
        break;
      }
      case 'search_key_provider': {
        const choice = await select(message, question.choices ?? []);
        collected.search_key_provider = choice ?? 'skip';
        break;
      }
      case 'search_key_secret': {
        const choice = collected.search_key_provider;
        if (choice === 'tavily' || choice === 'brave') {
          searchKey = await storeSearchKey(choice, message, password, keychain);
        }
        break;
      }
      case 'data_dir': {
        const value = (await text(message))?.trim();
        dataDir = nonEmpty(value) ?? null;
        collected.data_dir = dataDir;
        break;
      }
    }
  }

  return { provider, modelId, baseUrl, apiKey, dataDir, searchKey };
}

/**
 * Offer to store a keyed search provider's API key (FEAT-050). Without one,
 * web search scrapes a results page, which Yantra serializes and stops at the
 * first challenge. Same password prompt and keychain account convention as the
 * model step (`<provider>.api_key`). An unavailable keychain does not fail
 * `init`: the outcome carries the `yantra secret set` command to run later.
 */
async function storeSearchKey(
  choice: KeyedSearchProvider,
  message: string,
  password: NonNullable<InitProviderInput['password']>,
  keychain: NonNullable<InitProviderInput['keychain']>,
): Promise<SearchKeyOutcome> {
  const account = `${choice}.api_key`;
  const value = await password(message);
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
  const collected: Partial<Record<InitQuestionId, InitAnswerScalar>> = {};
  let locationGranted = true;
  let cityValue: string | null = null;

  for (const question of INIT_QUESTIONS) {
    if (question.section !== 'context' || !evaluateWhen(question, collected)) continue;
    const message = resolveQuestionMessage(question, collected);

    if (question.id === 'context_location') {
      const shareLocation = await confirm(message);
      if (shareLocation === null) {
        return defaultContextGrantAnswers();
      }
      collected.context_location = shareLocation;
      locationGranted = shareLocation;
    } else if (question.id === 'context_city') {
      const city = await text(message);
      const trimmed = city === null ? '' : city.trim();
      cityValue = trimmed.length > 0 ? trimmed : null;
      collected.context_city = cityValue;
    }
  }

  return {
    grants: { location: locationGranted, screenshots: false },
    city: locationGranted ? cityValue : null,
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
  readonly writeConfig?: typeof writeConfigDocument;
}
export type InitResult =
  | { readonly status: 'already-initialized'; readonly configPath: string }
  | { readonly status: 'invalid-provider'; readonly provider: string }
  | {
      readonly status: 'failed';
      readonly message: string;
      readonly code?: 'keychain_unavailable';
    }
  | {
      readonly status: 'written';
      readonly configPath: string;
      readonly profilePath: string;
      readonly writingProfile: boolean;
      readonly provider: InitAnswers['provider'];
      readonly searchKey: SearchKeyOutcome;
      readonly grants: ContextGrantAnswers;
    };

/** Thrown by {@link createPreAnsweredCollector} when an applicable question has no answer. */
export class InitMissingAnswerError extends Error {
  public override readonly name = 'InitMissingAnswerError';
  public constructor(public readonly questionId: InitQuestionId) {
    super(`Missing answer for required init question "${questionId}".`);
  }
}

/** Thrown by {@link createPreAnsweredCollector} when an answer violates question constraints. */
export class InitInvalidAnswerError extends Error {
  public override readonly name = 'InitInvalidAnswerError';
  public constructor(
    public readonly questionId: InitQuestionId,
    public readonly reason: string,
  ) {
    super(`Invalid answer for init question "${questionId}": ${reason}`);
  }
}

export interface PreAnsweredSecrets {
  readonly credential_secret?: string | undefined;
  readonly search_key_secret?: string | undefined;
}

export interface PreAnsweredCollectorDeps {
  readonly keychain?: () => Promise<KeychainProvider>;
}

function validatePreAnsweredAnswers(
  answers: Readonly<Record<string, InitAnswerScalar | undefined>>,
  secrets: PreAnsweredSecrets,
): Partial<Record<InitQuestionId, InitAnswerScalar>> {
  const collected: Partial<Record<InitQuestionId, InitAnswerScalar>> = {};
  for (const question of INIT_QUESTIONS) {
    if (!evaluateWhen(question, collected)) continue;

    if (question.kind === 'secret') {
      const secretVal = secrets[question.id as keyof PreAnsweredSecrets];
      if (secretVal !== undefined) {
        if (typeof secretVal !== 'string' || secretVal.length === 0) {
          throw new InitInvalidAnswerError(question.id, 'Secret value must be a non-empty string.');
        }
        if (new TextEncoder().encode(secretVal).length > CREDENTIAL_MAX_BYTES) {
          throw new InitInvalidAnswerError(question.id, 'Secret value must not exceed 8 KiB.');
        }
      }
      continue;
    }

    if (!(question.id in answers) || answers[question.id] === undefined) {
      throw new InitMissingAnswerError(question.id);
    }

    const raw = answers[question.id]!;
    switch (question.kind) {
      case 'select': {
        if (typeof raw !== 'string' || !question.choices?.includes(raw)) {
          throw new InitInvalidAnswerError(
            question.id,
            `Expected one of: ${(question.choices ?? []).join(', ')}.`,
          );
        }
        collected[question.id] = raw;
        break;
      }
      case 'confirm': {
        if (typeof raw !== 'boolean') {
          throw new InitInvalidAnswerError(question.id, 'Expected a boolean.');
        }
        collected[question.id] = raw;
        break;
      }
      case 'text': {
        if (raw === null) {
          if (!question.optional) {
            throw new InitInvalidAnswerError(question.id, 'Expected a non-empty string.');
          }
          collected[question.id] = null;
          break;
        }
        if (typeof raw !== 'string') {
          throw new InitInvalidAnswerError(question.id, 'Expected a string.');
        }
        const trimmed = raw.trim();
        if (!question.optional && trimmed.length === 0) {
          throw new InitInvalidAnswerError(question.id, 'Expected a non-empty string.');
        }
        if (question.id === 'credential_env_name') {
          const parsed = parseConfigRef(`\${env:${trimmed}}`);
          if (!parsed.isOk) {
            throw new InitInvalidAnswerError(question.id, parsed.error);
          }
        }
        if (question.id === 'data_dir' && trimmed.length > 0) {
          if (!(isAbsolute(trimmed) || win32.isAbsolute(trimmed))) {
            throw new InitInvalidAnswerError(question.id, 'the data directory must be absolute');
          }
        }
        collected[question.id] = trimmed.length > 0 ? trimmed : null;
        break;
      }
    }
  }
  return collected;
}

/**
 * Builds an {@link InitAnswerCollector} backed by pre-collected answers and secrets.
 * Validates every applicable question before any keychain or filesystem side effect.
 */
export function createPreAnsweredCollector(
  answers: Readonly<Record<string, InitAnswerScalar | undefined>>,
  secrets: PreAnsweredSecrets = {},
  deps: PreAnsweredCollectorDeps = {},
): InitAnswerCollector {
  function nextFrom(
    queue: InitQuestion[],
    expectedKind: 'select' | 'text' | 'secret' | 'confirm',
  ): InitQuestion {
    const question = queue.shift();
    if (question?.kind !== expectedKind) {
      throw new Error(`Pre-answered collector out of sync for ${expectedKind}.`);
    }
    return question;
  }

  return {
    providerAnswers: async () => {
      const validated = validatePreAnsweredAnswers(answers, secrets);
      const queue = INIT_QUESTIONS.filter(
        (q) => q.section !== 'context' && evaluateWhen(q, validated),
      );
      return collectInitProviderAnswers({
        select: () => {
          const q = nextFrom(queue, 'select');
          const value = validated[q.id];
          return Promise.resolve(typeof value === 'string' ? value : null);
        },
        text: () => {
          const q = nextFrom(queue, 'text');
          const value = validated[q.id];
          return Promise.resolve(typeof value === 'string' ? value : null);
        },
        password: () => {
          const q = nextFrom(queue, 'secret');
          const value = secrets[q.id as keyof PreAnsweredSecrets];
          return Promise.resolve(typeof value === 'string' ? value : null);
        },
        ...(deps.keychain ? { keychain: deps.keychain } : {}),
      });
    },
    contextGrants: async () => {
      const validated = validatePreAnsweredAnswers(answers, secrets);
      const queue = INIT_QUESTIONS.filter(
        (q) => q.section === 'context' && evaluateWhen(q, validated),
      );
      return collectInitContextGrants({
        confirm: () => {
          const q = nextFrom(queue, 'confirm');
          const value = validated[q.id];
          return Promise.resolve(typeof value === 'boolean' ? value : null);
        },
        text: () => {
          const q = nextFrom(queue, 'text');
          const value = validated[q.id];
          return Promise.resolve(typeof value === 'string' ? value : null);
        },
      });
    },
  };
}

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
    const writeConfig = deps.writeConfig ?? writeConfigDocument;
    await writeConfig(stringify(serializable(buildConfig(answers))), target, {
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
    if (
      error instanceof ResourceBusyError ||
      error instanceof InitMissingAnswerError ||
      error instanceof InitInvalidAnswerError
    ) {
      throw error;
    }
    if (error instanceof KeychainUnavailableError) {
      return { status: 'failed', message: error.message, code: 'keychain_unavailable' };
    }
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
