/**
 * `task_contract` tool spec (FEAT-052).
 *
 * Records what the user's goal requires — the deliverable, required fields,
 * filters, and any site the goal names — as a validated, sanitized,
 * normalized contract persisted to `contract.json`. It fetches nothing,
 * grants nothing, and is not a precondition for any other tool.
 */

import { TASK_CONTRACT_MAX_REVISIONS } from '@yantra/protocol';
import { Type, type Static } from 'typebox';

import { renderAgentMessage } from '../../../runtime/messages.js';
import type { DomainResult, ToolWrapperSpec } from '../../../runtime/middleware.js';
import type { RunServices } from '../../../runtime/run-services.js';
import { normalizeContract, type ContractIssue } from '../../../runtime/task-contract.js';

/** Requires at least one visible character, so cleaning can never empty a value. */
const VISIBLE = '\\S';

const Name = (description: string) =>
  Type.String({ minLength: 1, maxLength: 60, pattern: VISIBLE, description });

const TaskContractParams = Type.Object(
  {
    deliverable: Type.Union(
      [Type.Literal('table'), Type.Literal('answer'), Type.Literal('report')],
      {
        description:
          'table = rows with the same fields each; answer = a direct answer; report = prose findings.',
      },
    ),
    subject: Type.String({
      minLength: 1,
      maxLength: 200,
      pattern: VISIBLE,
      description: 'What the rows or the answer are about.',
    }),
    required_fields: Type.Optional(
      Type.Array(Name('One field each row or answer must carry, such as "price".'), {
        maxItems: 12,
        description: 'Every field the goal asks for. Required (non-empty) for a table.',
      }),
    ),
    filters: Type.Optional(
      Type.Array(
        Type.Object(
          {
            name: Name('The condition, such as "condition".'),
            value: Type.String({
              minLength: 1,
              maxLength: 120,
              pattern: VISIBLE,
              description: 'The required value, such as "new".',
            }),
          },
          { additionalProperties: false },
        ),
        { maxItems: 12, description: 'Every condition the goal states the results must meet.' },
      ),
    ),
    required_sources: Type.Optional(
      Type.Array(
        Type.String({
          minLength: 1,
          maxLength: 253,
          description: 'A site the goal names, as a hostname such as example.com.',
        }),
        {
          maxItems: 5,
          description:
            'Every site the goal names. A site named without its address goes in notes instead.',
        },
      ),
    ),
    ranking: Type.Optional(
      Type.Object(
        {
          field: Name('The field results are ordered by; for a table, one of required_fields.'),
          direction: Type.Union([Type.Literal('asc'), Type.Literal('desc')], {
            description: 'asc = lowest first; desc = highest first.',
          }),
        },
        { additionalProperties: false, description: 'How the goal asks results to be ordered.' },
      ),
    ),
    limit: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 50, description: 'How many results the goal asks for.' }),
    ),
    notes: Type.Optional(
      Type.String({
        maxLength: 500,
        description:
          'Anything the fields above cannot express, such as a site named without its address.',
      }),
    ),
  },
  { additionalProperties: false },
);

type TaskContractParamsType = Static<typeof TaskContractParams>;

/** The model-facing note on a recorded contract. */
const RECORDED_NOTE =
  'Contract recorded. Gather the evidence it needs; call task_contract again with the full ' +
  'contract only to correct a misreading.';

/**
 * The `contract_declared` runtime-log projection: counts and hostnames only,
 * never subject, field, filter, or note text.
 */
interface ContractDeclaredEvent {
  readonly schema_version: 1;
  readonly event: 'contract_declared';
  readonly revision: number;
  readonly deliverable: string;
  readonly field_count: number;
  readonly filter_count: number;
  readonly source_hosts: readonly string[];
}

/**
 * Build the `task_contract` tool spec for one run.
 *
 * @param _services Run services (the contract store is read per call).
 * @returns The provider-neutral tool spec consumed by `wrapTool`.
 */
export function taskContractSpec(
  _services: RunServices,
): ToolWrapperSpec<typeof TaskContractParams> {
  return {
    name: 'task_contract',
    label: 'Task Contract',
    description:
      "Record what the user's goal requires before gathering evidence: the deliverable, the " +
      'fields each row or answer needs, every filter the goal states, and any site the goal ' +
      'names (as a hostname). Call it in the same turn as your first search or fetch, so it ' +
      'costs no extra turn. Call it again with the full corrected contract if a later result ' +
      'shows the goal was misread. A site named without an address goes in notes. Do not use it ' +
      'to read pages: it fetches nothing and is not required for other tools to work.',
    parameters: TaskContractParams,
    sanitizationProfile: 'public',
    evidenceGathering: false,
    mutating: false,
    run: (params: TaskContractParamsType, ctx): Promise<DomainResult> =>
      declareContract(params, ctx.services),
  };
}

async function declareContract(
  params: TaskContractParamsType,
  services: RunServices,
): Promise<DomainResult> {
  const store = services.contract;
  if (services.actionPhase.isClosed()) {
    return {
      ok: false,
      errorCode: 'ACTION_PHASE_CLOSED',
      message: renderAgentMessage('middleware', 'ACTION_PHASE_CLOSED', 'published'),
      retryable: false,
      diagnostic: { cause: 'published' },
    };
  }
  if (store.revisionCount() >= TASK_CONTRACT_MAX_REVISIONS) {
    return {
      ok: false,
      errorCode: 'CONTRACT_REVISION_LIMIT',
      message: renderAgentMessage('tool', 'CONTRACT_REVISION_LIMIT', 'revisions'),
      retryable: false,
      diagnostic: { cause: 'revisions' },
    };
  }
  const vault = services.userInput;
  const normalized = normalizeContract(params, {
    sanitizer: services.sanitizer,
    ...(vault === undefined ? {} : { mask: (text: string) => vault.mask(text) }),
  });
  if (!normalized.isOk) {
    return {
      ok: false,
      errorCode: 'INVALID_INPUT',
      message: renderAgentMessage(
        'tool',
        'INVALID_INPUT',
        normalized.error.cause,
        issueDetails(normalized.error),
      ),
      retryable: true,
      diagnostic: { cause: normalized.error.cause },
    };
  }
  const contract = normalized.value;
  const { revision } = await store.declare(contract, services.nowIso());
  const event: ContractDeclaredEvent = {
    schema_version: 1,
    event: 'contract_declared',
    revision,
    deliverable: contract.deliverable,
    field_count: contract.required_fields.length,
    filter_count: contract.filters.length,
    source_hosts: contract.required_sources,
  };
  services.runtimeLogger?.info({ ...event }, 'contract declared');
  return {
    ok: true,
    model: { revision, contract, note: RECORDED_NOTE },
    details: {
      revision,
      field_count: contract.required_fields.length,
      filter_count: contract.filters.length,
      source_hosts: contract.required_sources,
    },
  };
}

function issueDetails(issue: ContractIssue): Record<string, unknown> {
  switch (issue.cause) {
    case 'contract-source-host':
      return { entry: issue.entry };
    case 'contract-duplicate':
      return { name: issue.name };
    case 'contract-ranking-field':
      return { field: issue.field };
    case 'contract-table-fields':
      return {};
  }
}
