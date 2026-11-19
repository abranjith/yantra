/**
 * Host RPC handlers for onboarding (`read.onboarding_status`, `onboarding.submit`).
 *
 * FEAT-071 TASK-004 (SD-1, DEVIATION-1, plan_ui D2 / §6):
 * - Runs the shared `init` service in-process with a pre-answered collector.
 * - Validates all applicable answers before any keychain or filesystem side effect.
 * - Enforces invocation_id idempotency across sequential and concurrent calls.
 * - Enforces the DEVIATION-1 relocation guard (`relocation_requires_terminal`).
 * - Never logs free text (e.g. `city`) or secret values on success or error.
 */

import { stat } from 'node:fs/promises';

import {
  InitInvalidAnswerError,
  InitMissingAnswerError,
  ResourceBusyError,
  configPath,
  createKeychainProvider,
  createPreAnsweredCollector,
  dataDir,
  keychainRemedy,
  loadConfig,
  profilePath,
  resetPathCache,
  runInit,
  storageDirSources,
  type InitServiceDependencies,
  type KeychainProvider,
  type ResourceLockOptions,
} from '@yantra/core';
import {
  EmptyParams,
  InitAnswersRequest,
  OnboardingResult,
  OnboardingStatus,
} from '@yantra/protocol';

import { SILENT_HOST_LOGGER, type HostLogger } from './host.js';
import { RpcError, type RpcMethodRegistry } from './rpc-server.js';

/** D15 steps returned when `data_dir` differs from the live configuration. */
export const D15_RELOCATION_STEPS = [
  'Close every Yantra window',
  'Run yantra init --reset or yantra config data-dir <path>',
  'Run yantra ui',
] as const;

export interface OnboardingHandlerDeps {
  readonly keychain?: () => Promise<KeychainProvider>;
  readonly loadConfig?: typeof loadConfig;
  readonly configPath?: () => string;
  readonly profilePath?: () => string;
  readonly dataDir?: typeof dataDir;
  readonly storageDirSources?: typeof storageDirSources;
  readonly runInit?: typeof runInit;
  readonly writeConfig?: InitServiceDependencies['writeConfig'];
  readonly lockOptions?: ResourceLockOptions;
  readonly now?: () => number;
  readonly logger?: HostLogger;
  readonly onSuccess?: () => void | Promise<void>;
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

function normalizeDataDirAnswer(raw: unknown): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Registers `read.onboarding_status` and `onboarding.submit` on the host RPC dispatcher. */
export function registerOnboarding(
  methods: RpcMethodRegistry,
  deps: OnboardingHandlerDeps = {},
): void {
  const logger = deps.logger ?? SILENT_HOST_LOGGER;
  const getConfigPath = deps.configPath ?? configPath;
  const getProfilePath = deps.profilePath ?? profilePath;
  const loadCfg = deps.loadConfig ?? loadConfig;
  const getKeychain = deps.keychain ?? createKeychainProvider;
  const getDataDir = deps.dataDir ?? dataDir;
  const getSources = deps.storageDirSources ?? storageDirSources;
  const executeInit = deps.runInit ?? runInit;

  const completed = new Map<string, OnboardingResult>();
  const inFlight = new Map<string, Promise<OnboardingResult>>();

  async function readConfiguredDataDir(cfgPath: string, exists: boolean): Promise<string | null> {
    if (!exists) return null;
    const loaded = await loadCfg(cfgPath);
    return loaded.isOk ? (loaded.value.paths.data_dir ?? null) : null;
  }

  async function executeSubmit(params: InitAnswersRequest): Promise<OnboardingResult> {
    const cfgPath = getConfigPath();
    const profPath = getProfilePath();
    const cfgExists = await fileExists(cfgPath);

    if (cfgExists && !params.reset) {
      throw new RpcError(
        'not_allowed',
        'Yantra is already initialized.',
        'Pass reset: true or run `yantra init --reset` to rewrite the existing configuration.',
        'already_initialized',
      );
    }

    const configuredDataDir = await readConfiguredDataDir(cfgPath, cfgExists);
    const requestedDataDir = normalizeDataDirAnswer(params.answers.data_dir);
    if (requestedDataDir !== undefined && requestedDataDir !== configuredDataDir) {
      throw new RpcError(
        'not_allowed',
        'Changing the data directory requires restarting Yantra from a terminal.',
        D15_RELOCATION_STEPS.join('; '),
        'relocation_requires_terminal',
      );
    }

    const collector = createPreAnsweredCollector(params.answers, params.secrets, {
      keychain: getKeychain,
    });

    let initResult: Awaited<ReturnType<typeof runInit>>;
    try {
      initResult = await executeInit(
        { reset: params.reset, yes: false, interactive: true },
        collector,
        {
          configPath: cfgPath,
          profilePath: profPath,
          ...(deps.now ? { now: deps.now } : {}),
          ...(deps.writeConfig ? { writeConfig: deps.writeConfig } : {}),
          lockOptions: {
            ...deps.lockOptions,
            owner: deps.lockOptions?.owner ?? {
              pid: process.pid,
              command: 'yantra ui',
              started_at: new Date().toISOString(),
              surface: 'host',
            },
          },
        },
      );
    } catch (error) {
      if (error instanceof InitMissingAnswerError) {
        logger.warn(
          { code: 'missing_answer', question_id: error.questionId },
          'onboarding_rejected',
        );
        throw new RpcError(
          'invalid_params',
          error.message,
          'Provide an explicit answer for every applicable onboarding question.',
          'missing_answer',
        );
      }
      if (error instanceof InitInvalidAnswerError) {
        logger.warn(
          { code: 'invalid_answer', question_id: error.questionId },
          'onboarding_rejected',
        );
        throw new RpcError(
          'invalid_params',
          error.message,
          'Provide a valid answer for this onboarding question.',
          'invalid_answer',
        );
      }
      if (error instanceof ResourceBusyError) {
        logger.warn({ code: 'busy' }, 'onboarding_rejected');
        throw new RpcError('busy', error.message, error.remediation, 'busy');
      }
      throw error;
    }

    if (initResult.status === 'already-initialized') {
      throw new RpcError(
        'not_allowed',
        'Yantra is already initialized.',
        'Pass reset: true or run `yantra init --reset` to rewrite the existing configuration.',
        'already_initialized',
      );
    }
    if (initResult.status === 'invalid-provider') {
      throw new RpcError(
        'invalid_params',
        `Unknown provider "${initResult.provider}".`,
        'Choose anthropic, ollama, or none.',
        'invalid_answer',
      );
    }
    if (initResult.status === 'failed') {
      if (initResult.code === 'keychain_unavailable') {
        logger.warn({ code: 'keychain_unavailable' }, 'onboarding_rejected');
        throw new RpcError(
          'not_allowed',
          initResult.message,
          keychainRemedy(),
          'keychain_unavailable',
        );
      }
      logger.error({ code: 'failed' }, 'onboarding_failed');
      throw new RpcError('internal_error', 'Onboarding could not be completed.');
    }

    resetPathCache();
    await deps.onSuccess?.();

    const response: OnboardingResult = {
      status: 'written',
      config_path: initResult.configPath,
      profile_path: initResult.profilePath,
      profile_written: initResult.writingProfile,
      provider: initResult.provider,
      search_key: initResult.searchKey.status,
      ...(initResult.searchKey.status === 'manual'
        ? { command: initResult.searchKey.command }
        : {}),
      location_shared: initResult.grants.grants.location,
    };

    logger.info(
      {
        status: response.status,
        provider: response.provider,
        search_key: response.search_key,
        profile_written: response.profile_written,
        reset: params.reset,
      },
      'onboarding_submitted',
    );

    return response;
  }

  methods
    .register('read.onboarding_status', {
      params: EmptyParams,
      result: OnboardingStatus,
      handler: async () => {
        const cfgPath = getConfigPath();
        const profPath = getProfilePath();
        const [cfgExists, profExists] = await Promise.all([
          fileExists(cfgPath),
          fileExists(profPath),
        ]);
        const configured = await readConfiguredDataDir(cfgPath, cfgExists);
        const sources = getSources();
        const effective = getDataDir();
        const keychainAvailable = await (async () => {
          try {
            return await (await getKeychain()).isAvailable();
          } catch {
            return false;
          }
        })();
        return {
          config_exists: cfgExists,
          profile_exists: profExists,
          config_path: cfgPath,
          profile_path: profPath,
          data_dir: {
            effective,
            source: sources.dataSource,
            configured,
          },
          keychain_available: keychainAvailable,
        };
      },
    })
    .register('onboarding.submit', {
      params: InitAnswersRequest,
      result: OnboardingResult,
      handler: async (params) => {
        const existing = completed.get(params.invocation_id);
        if (existing !== undefined) return existing;

        const pending = inFlight.get(params.invocation_id);
        if (pending !== undefined) return pending;

        const promise = executeSubmit(params);
        inFlight.set(params.invocation_id, promise);
        try {
          const result = await promise;
          completed.set(params.invocation_id, result);
          return result;
        } finally {
          inFlight.delete(params.invocation_id);
        }
      },
    });
}
