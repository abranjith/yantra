/**
 * The Mission screen's host reads (FEAT-067).
 *
 * `read.run_recovery {run_id}`: Resume and Run again for a finished run.
 *
 * `read.workflow_params {name}`: a saved workflow's declared params, in
 * declared order, for Run mode.
 *
 * `read.mission_context`: the user's home (a new run's default working
 * directory, D13) and the host platform.
 *
 * `read.effective_options {path, argv, cwd}`: every option the composed
 * command would use, with its effective value and its source, resolved
 * read-only through FEAT-072's settings resolver (the same path drift review
 * and the execution receipt take, so the composer shows what the run will
 * record). The precedence chain is never restated here.
 *
 * - The source vocabulary is the receipt's: flag, environment variable
 *   **name**, preference or config **key**, default.
 * - A secret-input option is left out; a secret-reference option
 *   (`--auth-secret`) carries its reference name, which is all it holds.
 * - Known dead controls (protocol KNOWN_DEAD_OPTIONS) and options whose
 *   registry applicability does not hold in the resolved mode are left out.
 *
 * Failures are typed RPC errors; the host logs only the read name and error
 * code, never argv, values or goals (plan §11).
 */

import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  FileWorkflowStore,
  assessPriorEffects,
  recoverPriorInvocation,
  runsRoot,
  workflowsRoot,
} from '@yantra/core';
import { LocalRunStore, assessResumability } from '@yantra/core/workflow/replay';
import {
  COMMAND_REGISTRY,
  EmptyParams,
  MissionContext,
  ProviderReadiness,
  RunRecoveryAssessment,
  RunRecoveryParams,
  findLeaf,
  WorkflowParams,
  WorkflowParamsParams,
  EffectiveOptions,
  EffectiveOptionsParams,
  conditionHolds,
  createInvocationId,
  expandOptions,
  isKnownDeadOption,
  parseInvocation,
  type EffectiveOptionView,
  type InvocationFacts,
} from '@yantra/protocol';

import type {
  AgentInvocation,
  AgentInvocationDependencies,
  AgentOptions,
} from '../../agent-options.js';

import type { InvocationSettingsResolver } from './drift-review.js';
import { SILENT_HOST_LOGGER, type HostLogger } from './host.js';
import { RpcError, type RpcMethodRegistry } from './rpc-server.js';

/** Resolves an agentic invocation without opening a provider session (`resolveAgentInvocation`). */
export type AgentResolver = (
  command: string,
  options: AgentOptions,
  env: NodeJS.ProcessEnv,
) => Promise<AgentInvocation>;

/** Words for a deterministic choice made before any provider is consulted. */
const NO_LLM_WORDS: Readonly<Record<string, string>> = {
  flag: 'The model is turned off for this run (--no-llm).',
  env: 'The model is turned off on this computer (LLM_PROVIDER=none).',
};

/**
 * `read.provider_readiness`: whether `do` could open a provider session now.
 * It resolves provider, model and credential exactly as the command does
 * (`resolveAgentInvocation`, whose credential probe opens no session), and
 * names a real registry command that fixes a missing credential.
 */
export async function providerReadiness(
  params: EffectiveOptionsParams,
  env: NodeJS.ProcessEnv,
  resolveAgent: AgentResolver,
): Promise<ProviderReadiness> {
  const parsed = parseInvocation([...params.path, ...params.argv], {
    cwd: params.cwd,
    invocationId: createInvocationId(),
  });
  if (!parsed.isOk) {
    throw new RpcError('invalid_params', parsed.error.message, 'Check the options shown in red.');
  }
  let agent: AgentInvocation;
  try {
    agent = await resolveAgent(parsed.value.entry.id, parsed.value.options, env);
  } catch (error) {
    // An invalid provider or model value: the command's own words, no secret in them.
    return {
      ready: false,
      provider: '',
      model: '',
      reason: error instanceof Error ? error.message : 'The model settings are not valid.',
      fix: { label: 'See the configured models', path: ['model', 'list'], argv: [] },
    };
  }
  if (agent.mode === 'llm') {
    return { ready: true, provider: agent.model.provider, model: agent.model.id };
  }
  if (agent.reason !== 'unavailable') {
    return {
      ready: false,
      provider: '',
      model: '',
      reason: NO_LLM_WORDS[agent.reason] ?? 'The model is turned off.',
    };
  }
  const provider = agent.model.provider;
  const runtimeKey = agent.auth.mode === 'runtime-key' ? agent.auth.secretRef : null;
  return {
    ready: false,
    provider,
    model: agent.model.id,
    reason:
      runtimeKey === null
        ? `No credential for ${provider} is set up on this computer.`
        : `The secret ${runtimeKey} is not stored on this computer.`,
    fix:
      runtimeKey === null
        ? { label: `Set up ${provider}`, path: ['init'], argv: [] }
        : { label: `Store ${runtimeKey}`, path: ['secret', 'set'], argv: [runtimeKey] },
  };
}

/**
 * `read.run_recovery {run_id}`: Resume through the core resumability rule
 * (the one `yantra resume` applies), and Run again from the run's recorded
 * command with what it may have changed on websites. Each artifact fails on
 * its own; only an unknown run is an error.
 */
export async function runRecovery(
  runId: string,
  root: string = runsRoot(),
): Promise<RunRecoveryAssessment> {
  const runDir = join(root, runId);
  const exists = await stat(runDir).then(
    (info) => info.isDirectory(),
    () => false,
  );
  if (!exists)
    throw new RpcError('not_found', `There is no run ${runId}.`, 'Open the Ledger to find it.');
  const [resume, prior] = await Promise.all([
    assessResumability(new LocalRunStore(root), runId),
    recoverPriorInvocation(runDir),
  ]);
  const effect = (prior.path === null ? undefined : findLeaf(prior.path))?.effect ?? 'external';
  const effects = await assessPriorEffects(runDir, effect);
  return {
    run_id: runId,
    resume: resume.available
      ? {
          available: true,
          requires_consent: resume.requiresConsent,
          ...(resume.failureClass === undefined ? {} : { failure_class: resume.failureClass }),
        }
      : { available: false, reason: resume.reason },
    run_again: {
      prior: prior.prior,
      path: prior.path === null ? null : [...prior.path],
      argv: prior.argv === null ? null : [...prior.argv],
      pinned_argv: prior.pinnedArgv === null ? null : [...prior.pinnedArgv],
      cwd: prior.cwd,
      effects: effects.effects,
      effect_reasons: [...effects.reasons],
      notices: [...prior.notices],
    },
  };
}

export interface MissionReadDeps {
  /** Resolves an invocation's effective settings (production: `effectiveSettingsResolver`). */
  readonly resolve: InvocationSettingsResolver;
  readonly logger?: HostLogger;
  /** The host's environment (D13). */
  readonly env?: NodeJS.ProcessEnv;
  /** Resolves an agentic invocation (production: `resolveAgentInvocation` over preferences). */
  readonly resolveAgent?: AgentResolver;
  /** The runs root (tests inject one). */
  readonly runsRoot?: () => string;
  /** Loads a saved workflow's declared params (tests inject one). */
  readonly loadWorkflowParams?: (name: string) => Promise<WorkflowParams | null>;
  /** The user's home directory (tests inject one). */
  readonly home?: () => string;
  readonly platform?: string;
}

/** `read.effective_options`; see the module comment. */
export async function effectiveOptions(
  params: EffectiveOptionsParams,
  resolve: InvocationSettingsResolver,
): Promise<EffectiveOptions> {
  const parsed = parseInvocation([...params.path, ...params.argv], {
    cwd: params.cwd,
    invocationId: createInvocationId(),
  });
  if (!parsed.isOk) {
    throw new RpcError('invalid_params', parsed.error.message, 'Check the options shown in red.');
  }
  const { entry, invocation } = parsed.value;
  const settings = new Map((await resolve(invocation)).map((setting) => [setting.key, setting]));
  const llm = settings.get('llm')?.value;
  const mode = llm === false ? 'deterministic' : 'llm';
  const facts: InvocationFacts = {
    options: parsed.value.options,
    arguments: parsed.value.arguments,
    explicit: parsed.value.explicit,
    mode,
  };
  const options: EffectiveOptionView[] = [];
  for (const spec of expandOptions(entry, COMMAND_REGISTRY.option_groups)) {
    if (spec.input.kind === 'secret-input') continue;
    if (isKnownDeadOption(entry.id, spec.long)) continue;
    if (spec.applicability?.some((condition) => !conditionHolds(condition, facts)) === true)
      continue;
    const setting = settings.get(spec.attribute);
    if (setting === undefined) continue;
    options.push({
      option: spec.attribute,
      flag: spec.long,
      value: setting.value,
      source: setting.source,
    });
  }
  return { path: [...entry.path], mode, options };
}

/** Registers the Mission reads. */
export function registerMissionReads(methods: RpcMethodRegistry, deps: MissionReadDeps): void {
  const logger = deps.logger ?? SILENT_HOST_LOGGER;
  // A new run's working directory is the user's home, not where the host started (D13).
  methods.register('read.mission_context', {
    params: EmptyParams,
    result: MissionContext,
    handler: () => ({
      home: (deps.home ?? homedir)(),
      platform: deps.platform ?? process.platform,
    }),
  });
  methods.register('read.run_recovery', {
    params: RunRecoveryParams,
    result: RunRecoveryAssessment,
    handler: ({ run_id: runId }) => runRecovery(runId, (deps.runsRoot ?? runsRoot)()),
  });
  methods.register('read.workflow_params', {
    params: WorkflowParamsParams,
    result: WorkflowParams,
    handler: async ({ name }) => {
      const loaded = await (deps.loadWorkflowParams ?? loadWorkflowParams)(name);
      if (loaded === null) {
        throw new RpcError(
          'not_found',
          `There is no saved workflow ${name}.`,
          'Pick one from the list.',
        );
      }
      return loaded;
    },
  });
  methods.register('read.provider_readiness', {
    params: EffectiveOptionsParams,
    result: ProviderReadiness,
    handler: async (params) => {
      const resolveAgent = deps.resolveAgent ?? (await defaultAgentResolver());
      try {
        return await providerReadiness(params, { ...(deps.env ?? {}) }, resolveAgent);
      } catch (error) {
        logger.warn(
          {
            read: 'read.provider_readiness',
            code: error instanceof RpcError ? error.data.code : 'internal_error',
          },
          'read failed',
        );
        if (error instanceof RpcError) throw error;
        throw new RpcError('internal_error', 'Provider readiness could not be checked.');
      }
    },
  });
  methods.register('read.effective_options', {
    params: EffectiveOptionsParams,
    result: EffectiveOptions,
    handler: async (params) => {
      try {
        return await effectiveOptions(params, deps.resolve);
      } catch (error) {
        logger.warn(
          {
            read: 'read.effective_options',
            code: error instanceof RpcError ? error.data.code : 'internal_error',
          },
          'read failed',
        );
        if (error instanceof RpcError) throw error;
        throw new RpcError('internal_error', 'The options could not be resolved.');
      }
    },
  });
}

/** `resolveAgentInvocation` over the stored preferences, loaded on first use. */
async function defaultAgentResolver(
  dependencies: AgentInvocationDependencies = {},
): Promise<AgentResolver> {
  // Loaded on first use: the agent surface would delay the host becoming ready.
  const { resolveAgentInvocation } = await import('../../agent-options.js');
  const { loadEffectivePreferences } = await import('../../preferences.js');
  return async (command, options, env) =>
    resolveAgentInvocation(command, options, env, await loadEffectivePreferences(), dependencies);
}

/** A saved workflow's declared params through the workflow store, or null when it does not load. */
export async function loadWorkflowParams(
  name: string,
  store: Pick<FileWorkflowStore, 'load'> = new FileWorkflowStore(workflowsRoot()),
): Promise<WorkflowParams | null> {
  const loaded = await store.load(name).catch(() => null);
  if (!loaded?.isOk) return null;
  return {
    name: loaded.value.name,
    params: Object.entries(loaded.value.params).map(([key, declaration]) => ({
      key,
      type: declaration.type,
      required: declaration.required,
      example: declaration.example,
    })),
  };
}
