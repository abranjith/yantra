/**
 * `script_run` tool spec (FEAT-024 TASK-006, plan_agentic.md §5/§8.8).
 *
 * Executes a *named*, allowlisted transformation script from the `@yantra/core`
 * registry with validated arguments. It never accepts an arbitrary command
 * string — the tool input is a registered id plus args, and the registry runs
 * the transform out-of-process with time/memory/output caps. The trust boundary
 * is the code-defined registry, not OS sandboxing.
 */

import { Type, type Static } from 'typebox';

import type { DomainResult, ToolWrapperSpec } from '../../../runtime/middleware.js';
import type { RunServices } from '../../../runtime/run-services.js';

const ScriptRunParams = Type.Object(
  {
    script_id: Type.String({
      minLength: 1,
      maxLength: 100,
      description: 'The id of a registered transformation script (see the tool description).',
    }),
    args: Type.Unknown({
      description: 'Arguments for the script; validated against the script’s own schema.',
    }),
  },
  { additionalProperties: false },
);

type ScriptRunParamsType = Static<typeof ScriptRunParams>;

/**
 * Build the `script_run` tool spec for one run.
 *
 * @param services Run services; the registered script ids are listed in the
 *   tool description so the model knows what is available.
 * @returns The provider-neutral tool spec consumed by `wrapTool`.
 */
export function scriptRunSpec(services: RunServices): ToolWrapperSpec<typeof ScriptRunParams> {
  const ids = services.domain.script.registry.ids();
  return {
    name: 'script_run',
    label: 'Run Script',
    description:
      'Run a named, trusted transformation script over data you already have. ' +
      `Available scripts: ${ids.length > 0 ? ids.join(', ') : '(none registered)'}. ` +
      'Use it to reshape or tidy structured text (e.g. normalize a table). Do NOT use it to ' +
      'run arbitrary code, shell commands, or to fetch data — it only accepts these registered ids.',
    parameters: ScriptRunParams,
    sanitizationProfile: 'public',
    run: (params: ScriptRunParamsType, ctx): Promise<DomainResult> =>
      runScript(params, ctx.services, ctx.signal),
  };
}

async function runScript(
  params: ScriptRunParamsType,
  services: RunServices,
  signal: AbortSignal,
): Promise<DomainResult> {
  const outcome = await services.domain.script.registry.run(params.script_id, params.args, {
    signal,
  });
  if (!outcome.ok) {
    return {
      ok: false,
      errorCode: outcome.errorCode,
      message: outcome.message,
      retryable: outcome.retryable,
    };
  }
  return {
    ok: true,
    model: { script_id: params.script_id, output: outcome.output, truncated: outcome.truncated },
    details: { truncated: outcome.truncated },
  };
}
