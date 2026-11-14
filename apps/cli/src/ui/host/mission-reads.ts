/**
 * The Mission screen's host reads (FEAT-067).
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

import {
  COMMAND_REGISTRY,
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

import type { InvocationSettingsResolver } from './drift-review.js';
import { SILENT_HOST_LOGGER, type HostLogger } from './host.js';
import { RpcError, type RpcMethodRegistry } from './rpc-server.js';

export interface MissionReadDeps {
  /** Resolves an invocation's effective settings (production: `effectiveSettingsResolver`). */
  readonly resolve: InvocationSettingsResolver;
  readonly logger?: HostLogger;
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
