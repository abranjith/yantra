/**
 * `task_contract` tool spec (FEAT-052, FEAT-054).
 *
 * Records what the user's goal requires — the deliverable, required fields,
 * filters, any site the goal names, and (for `do`) the page actions: which
 * fields to fill, which screenshots to capture, and whether submitting is
 * forbidden — as a validated, sanitized, normalized contract persisted to
 * `contract.json`. It fetches nothing and grants nothing. In `do` it is a
 * precondition for `result_publish` (FEAT-054 D4), so it stays callable during
 * the exploration wind-down.
 */

import { TASK_CONTRACT_MAX_REVISIONS, artifactRequirementId } from '@yantra/protocol';
import { Type, type Static } from 'typebox';

import {
  visionContractCapabilities,
  type CaptureGapReason,
} from '../../../runtime/contract-capabilities.js';
import { renderAgentMessage } from '../../../runtime/messages.js';
import type { DomainResult, ToolWrapperSpec } from '../../../runtime/middleware.js';
import type { RunServices } from '../../../runtime/run-services.js';
import {
  normalizeContract,
  type ContractIssue,
  type EffectiveActionTerms,
} from '../../../runtime/task-contract.js';

/** Requires at least one visible character, so cleaning can never empty a value. */
const VISIBLE = '\\S';

const Name = (description: string) =>
  Type.String({ minLength: 1, maxLength: 60, pattern: VISIBLE, description });

const TaskContractParams = Type.Object(
  {
    deliverable: Type.Union(
      [
        Type.Literal('table'),
        Type.Literal('answer'),
        Type.Literal('report'),
        Type.Literal('actions'),
      ],
      {
        description:
          'table = rows with the same fields each; answer = a direct answer; report = prose ' +
          'findings; actions = the goal changes or captures a page (fill a form, take a ' +
          'screenshot) and the result reports what was done.',
      },
    ),
    subject: Type.String({
      minLength: 1,
      maxLength: 200,
      pattern: VISIBLE,
      description: 'What the rows, the answer, or the actions are about.',
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
            'Every site the goal names; for actions, the site the actions happen on. A site ' +
            'named without its address goes in notes instead.',
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
    fill: Type.Optional(
      Type.Object(
        {
          coverage: Type.Union([Type.Literal('all_eligible'), Type.Literal('listed')], {
            description:
              'all_eligible = the goal says "every field" or "the whole form"; the engine ' +
              'decides which controls are eligible. listed = only the fields named in fields.',
          }),
          fields: Type.Optional(
            Type.Array(Name('A field label the goal names, such as "Email".'), {
              maxItems: 40,
              description: 'The fields to fill. Required for listed; omit for all_eligible.',
            }),
          ),
        },
        {
          additionalProperties: false,
          description:
            'Which form fields the goal asks to fill. Put "fill every field" here, not in notes.',
        },
      ),
    ),
    artifacts: Type.Optional(
      Type.Array(
        Type.Object(
          {
            kind: Type.Literal('screenshot', { description: 'The artifact kind.' }),
            scope: Type.Union(
              [Type.Literal('viewport'), Type.Literal('full_page'), Type.Literal('element')],
              {
                description:
                  'viewport = what is on screen; full_page = the whole page; element = one element.',
              },
            ),
          },
          { additionalProperties: false },
        ),
        {
          maxItems: 3,
          description:
            'Every screenshot the goal asks for, once per scope. Put a requested screenshot ' +
            'here, not in notes.',
        },
      ),
    ),
    effects: Type.Optional(
      Type.Object(
        {
          submit: Type.Union([Type.Literal('forbidden'), Type.Literal('allowed')], {
            description:
              'forbidden = the goal says not to submit; the engine then refuses any click ' +
              'that would submit a form.',
          }),
        },
        {
          additionalProperties: false,
          description: 'Side effects the goal permits. Put "do not submit" here, not in notes.',
        },
      ),
    ),
    notes: Type.Optional(
      Type.String({
        maxLength: 500,
        description:
          'Anything the fields above cannot express, such as a site named without its address. ' +
          'Never a fill, screenshot, or submit requirement: those have their own fields.',
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

/** One declared item the run cannot deliver, as the model sees it. */
interface CapabilityGap {
  readonly item: string;
  readonly reason: CaptureGapReason;
}

/**
 * The `contract_declared` runtime-log projection: counts, hostnames, and
 * closed-set values only, never subject, field, filter, or note text.
 */
interface ContractDeclaredEvent {
  readonly schema_version: 1;
  readonly event: 'contract_declared';
  readonly revision: number;
  readonly deliverable: string;
  readonly field_count: number;
  readonly filter_count: number;
  readonly source_hosts: readonly string[];
  readonly fill_coverage: 'all_eligible' | 'listed' | null;
  readonly artifact_count: number;
  readonly submit: 'forbidden' | 'allowed';
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
      'names (as a hostname). For a goal that fills a form, takes a screenshot, or must not ' +
      'submit, use deliverable "actions" with fill, artifacts, and effects. Call it in the ' +
      'same turn as your first search, fetch, or page action, so it costs no extra turn. Call ' +
      'it again with the full corrected contract if a later result shows the goal was ' +
      'misread. A site named without an address goes in notes. Do not use it to read pages: ' +
      'it fetches nothing.',
    parameters: TaskContractParams,
    sanitizationProfile: 'public',
    evidenceGathering: false,
    mutating: false,
    windDownExempt: true,
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
    command: store.command,
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
  const terms = store.effectiveActionTerms();
  const event: ContractDeclaredEvent = {
    schema_version: 1,
    event: 'contract_declared',
    revision,
    deliverable: contract.deliverable,
    field_count: contract.required_fields.length,
    filter_count: contract.filters.length,
    source_hosts: contract.required_sources,
    fill_coverage: terms.fill?.coverage ?? null,
    artifact_count: terms.artifacts.length,
    submit: terms.submit.value,
  };
  services.runtimeLogger?.info({ ...event }, 'contract declared');
  const gaps = capabilityGaps(terms, services);
  return {
    ok: true,
    model: {
      revision,
      contract,
      ...(gaps.length === 0 ? {} : { capability_gaps: gaps }),
      note: RECORDED_NOTE,
    },
    details: {
      revision,
      field_count: contract.required_fields.length,
      filter_count: contract.filters.length,
      source_hosts: contract.required_sources,
      ...(gaps.length === 0 ? {} : { capability_gaps: gaps }),
    },
  };
}

/**
 * Every declared artifact this run cannot produce, so the model knows at
 * declaration time instead of at publication. Empty when nothing is missing.
 */
function capabilityGaps(terms: EffectiveActionTerms, services: RunServices): CapabilityGap[] {
  if (terms.artifacts.length === 0) return [];
  const resolver = services.contractCapabilities ?? visionContractCapabilities(services.vision);
  const gaps: CapabilityGap[] = [];
  for (const artifact of terms.artifacts) {
    const reason = resolver.captureGap(artifact.scope);
    if (reason !== null) gaps.push({ item: artifactRequirementId(artifact.scope), reason });
  }
  return gaps;
}

function issueDetails(issue: ContractIssue): Record<string, unknown> {
  switch (issue.cause) {
    case 'contract-source-host':
      return { entry: issue.entry };
    case 'contract-duplicate':
      return { name: issue.name };
    case 'contract-ranking-field':
      return { field: issue.field };
    case 'contract-fill-fields':
      return { coverage: issue.coverage };
    case 'contract-table-fields':
    case 'contract-actions-command':
      return {};
  }
}
