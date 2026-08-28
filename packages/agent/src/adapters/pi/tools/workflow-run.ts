/**
 * `workflow_run` — deterministic saved-workflow discovery and invocation
 * (FEAT-027 TASK-002, plan_agentic.md §5).
 *
 * A single tool with two modes keeps the catalog and its invocation adjacent for
 * the model:
 *
 * - `list` returns the **secret-free** workflow catalog (name/description/params/
 *   hosts). The agent never sees secret names/values, locator internals, or
 *   profile paths.
 * - `run` validates the workflow exists and its params against the declared
 *   types, then executes it through the existing deterministic `RunOrchestrator`
 *   (LLM-free by construction — the executor path never imports `@yantra/agent`).
 *   The nested run gets its own run directory; the tool result returns a
 *   sanitized terminal status/outputs summary plus the nested `run_id`.
 *
 * Confirmation checkpoints inside the workflow use the FEAT-026 connector bridge
 * (`services.confirmation.gateway`); scheduled/non-interactive surfaces have no
 * gateway and their flagged steps fail closed.
 */

import type { WorkflowCatalogEntry } from '@yantra/core';
import { Type, type Static } from 'typebox';

import type { DomainResult, ToolWrapperSpec } from '../../../runtime/middleware.js';
import type { RunServices } from '../../../runtime/run-services.js';

const WorkflowRunParams = Type.Object(
  {
    mode: Type.Union([Type.Literal('list'), Type.Literal('run')], {
      description: 'list = return the saved-workflow catalog; run = execute one workflow.',
    }),
    workflow: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 64,
        description: 'Workflow name to run (required for run mode; ignored for list).',
      }),
    ),
    params: Type.Optional(
      Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Boolean()]), {
        description: 'Declared workflow parameters by name (run mode only).',
      }),
    ),
  },
  { additionalProperties: false },
);
type Params = Static<typeof WorkflowRunParams>;

/** Build the deterministic workflow discovery/invocation tool. */
export function workflowRunSpec(services: RunServices): ToolWrapperSpec<typeof WorkflowRunParams> {
  return {
    name: 'workflow_run',
    label: 'Workflow Run',
    description:
      services.workflowToolMode === 'list'
        ? 'Discover saved deterministic Yantra workflows with mode:list. This command may NOT run workflows; use the catalog only to identify a suitable saved automation. Do NOT use it to see workflow secrets or internal locators.'
        : 'Discover (mode:list) and run (mode:run) a saved, deterministic Yantra workflow. Prefer a saved workflow over ad-hoc browsing when one matches the goal — it replays reliably with no model involvement. Do NOT use it to see workflow secrets or internal locators, and do NOT pass secret values as params.',
    parameters: WorkflowRunParams,
    sanitizationProfile: 'public',
    mutating: true,
    run: (params: Params, ctx): Promise<DomainResult> => runWorkflowTool(params, ctx.services),
  };
}

async function runWorkflowTool(params: Params, services: RunServices): Promise<DomainResult> {
  if (services.workflowToolMode === 'list' && params.mode === 'run') {
    return {
      ok: false,
      errorCode: 'WORKFLOW_RUN_NOT_ALLOWED',
      message: 'This command can discover saved workflows but cannot run one.',
      retryable: false,
    };
  }
  const deps = services.domain.workflow;
  if (!deps) {
    return {
      ok: false,
      errorCode: 'WORKFLOW_UNAVAILABLE',
      message: 'Saved-workflow execution is not configured for this run.',
      retryable: false,
    };
  }

  const catalog = await deps.listCatalog();

  if (params.mode === 'list') {
    return { ok: true, model: { workflows: catalog } };
  }

  // run mode.
  const name = params.workflow?.trim();
  if (name === undefined || name.length === 0) {
    return {
      ok: false,
      errorCode: 'WORKFLOW_NAME_REQUIRED',
      message: 'A workflow name is required to run a workflow. List the catalog first.',
      retryable: true,
    };
  }
  const entry = catalog.find((candidate) => candidate.name === name);
  if (entry === undefined) {
    return {
      ok: false,
      errorCode: 'WORKFLOW_NOT_FOUND',
      message: `No saved workflow named "${name}". Use mode:list to see available workflows.`,
      retryable: true,
    };
  }

  const validation = validateParams(entry, params.params ?? {});
  if (!validation.ok) return validation.failure;

  const outcome = await deps.run(
    { workflow: name, params: validation.params },
    {
      signal: services.abortSignal,
      confirmationGateway: services.confirmation?.gateway ?? null,
    },
  );

  if (!outcome.ok) {
    return {
      ok: false,
      errorCode: outcome.errorCode,
      message: outcome.message,
      retryable: outcome.retryable,
      details: { nested_run_id: outcome.runId },
    };
  }

  return {
    ok: true,
    model: {
      status: 'completed',
      run_id: outcome.runId,
      step_count: outcome.stepCount,
      outputs: outcome.outputs,
    },
    details: { nested_run_id: outcome.runId },
  };
}

type ParamValidation =
  | { readonly ok: true; readonly params: Record<string, string | number | boolean> }
  | { readonly ok: false; readonly failure: DomainResult };

/**
 * Validates supplied params against the catalog entry's declared params:
 * required params must be present and every supplied value's JS type must match
 * the declared scalar type. Errors name the offending param.
 */
function validateParams(
  entry: WorkflowCatalogEntry,
  supplied: Readonly<Record<string, string | number | boolean>>,
): ParamValidation {
  const declared = new Map(entry.params.map((param) => [param.name, param]));

  for (const key of Object.keys(supplied)) {
    if (!declared.has(key)) {
      return {
        ok: false,
        failure: {
          ok: false,
          errorCode: 'WORKFLOW_PARAM_INVALID',
          message: `Unknown parameter "${key}" for workflow "${entry.name}".`,
          retryable: true,
        },
      };
    }
  }

  const resolved: Record<string, string | number | boolean> = {};
  for (const param of entry.params) {
    const value = supplied[param.name];
    if (value === undefined) {
      if (param.required) {
        return {
          ok: false,
          failure: {
            ok: false,
            errorCode: 'WORKFLOW_PARAM_INVALID',
            message: `Missing required parameter "${param.name}" for workflow "${entry.name}".`,
            retryable: true,
          },
        };
      }
      continue;
    }
    if (!typeMatches(param.type, value)) {
      return {
        ok: false,
        failure: {
          ok: false,
          errorCode: 'WORKFLOW_PARAM_INVALID',
          message: `Parameter "${param.name}" must be a ${param.type}.`,
          retryable: true,
        },
      };
    }
    resolved[param.name] = value;
  }

  return { ok: true, params: resolved };
}

/** True when a supplied JS value matches a declared scalar param type. */
function typeMatches(
  type: WorkflowCatalogEntry['params'][number]['type'],
  value: unknown,
): boolean {
  switch (type) {
    case 'number':
      return typeof value === 'number';
    case 'boolean':
      return typeof value === 'boolean';
    case 'string':
    case 'date':
      // Dates arrive as ISO strings over the tool boundary.
      return typeof value === 'string';
  }
}
