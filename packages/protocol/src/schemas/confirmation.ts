import { z } from 'zod';

import { ULID_PATTERN } from '../utils/ulid.js';

/**
 * Confirmation protocol — the consent gateway's wire format.
 *
 * A `ConfirmationRequest` is emitted by the executor when a step flagged
 * `requires_confirmation` is about to execute. The request persists to
 * `runs/<run-id>/confirmations.jsonl` and is resolved by exactly one
 * `ConfirmationDecision` — always originating from a human-operated
 * `ConnectorIO`, never from the agent.
 *
 * @see .spec-lite/features/feature_human_in_the_loop.md §2
 */

/** Verbs that may carry `requires_confirmation`. */
export const CONFIRMABLE_ACTION_KINDS = ['click', 'fill', 'navigate'] as const;

export type ConfirmableActionKind = (typeof CONFIRMABLE_ACTION_KINDS)[number];

/** Reversibility classification for the action being confirmed. */
export const ConsequenceLevel = z
  .enum(['reversible', 'hard_to_reverse', 'irreversible', 'unknown'])
  .describe('How difficult it would be to undo the action if it goes wrong.');

export type ConsequenceLevel = z.infer<typeof ConsequenceLevel>;

/** Best-effort cost estimate attached to a confirmation request. */
export const ExpectedCost = z
  .object({
    amount: z.number().describe('Numeric cost amount.'),
    currency: z
      .string()
      .min(1)
      .describe('ISO 4217 currency code or descriptive label (e.g. "USD", "credits").'),
  })
  .describe('Best-effort cost estimate for the action being confirmed.');

export type ExpectedCost = z.infer<typeof ExpectedCost>;

/**
 * Structured request for human consent before executing a flagged step.
 *
 * Emitted by the executor checkpoint, persisted to `confirmations.jsonl`,
 * and resolved by a `ConfirmationDecision` from a human-operated connector.
 */
export const ConfirmationRequest = z
  .object({
    confirmation_id: z
      .string()
      .regex(ULID_PATTERN)
      .describe('Globally unique ULID for this confirmation request.'),
    run_id: z.string().min(1).describe('Owning run id.'),
    step_id: z.string().min(1).describe('Step id that triggered the request.'),
    action_kind: z
      .enum(CONFIRMABLE_ACTION_KINDS)
      .describe('The mutating verb that will execute on grant.'),
    host: z
      .string()
      .min(1)
      .describe('Resolved target host for the action (e.g. "bank.example.com").'),
    description: z
      .string()
      .min(1)
      .describe('Human-readable summary of what will happen — from step name or annotation.'),
    expected_cost: ExpectedCost.nullable().describe(
      'Best-effort cost estimate, or null if unknown.',
    ),
    consequence: ConsequenceLevel.default('unknown').describe('Reversibility classification.'),
    requested_at: z
      .string()
      .datetime()
      .describe('ISO-8601 UTC timestamp when the request was created.'),
    timeout_ms: z
      .number()
      .int()
      .positive()
      .nullable()
      .describe('Timeout in milliseconds, or null to wait indefinitely (interactive mode).'),
  })
  .describe('Structured consent request emitted before a flagged step executes.');

export type ConfirmationRequest = z.infer<typeof ConfirmationRequest>;

/**
 * Provenance of a confirmation decision.
 *
 * The union is deliberately closed: there is **no agent-shaped variant**.
 * Unforgeability starts at the type level — only a human-operated
 * `ConnectorIO` can produce a decision, and the `decided_by` field
 * records which surface granted it.
 */
export const ConfirmationDecidedBy = z
  .enum(['user_interactive', 'user_cli_confirm', 'timeout'])
  .describe('Who or what resolved the confirmation — no agent variant exists.');

export type ConfirmationDecidedBy = z.infer<typeof ConfirmationDecidedBy>;

/**
 * The terminal resolution of a `ConfirmationRequest`.
 *
 * Exactly one decision exists per request. `granted` is single-use and
 * step-scoped. `denied` and `timed_out` both abort the run (exit 4).
 */
export const ConfirmationDecision = z
  .object({
    confirmation_id: z.string().regex(ULID_PATTERN).describe('ULID of the request being resolved.'),
    decision: z
      .enum(['granted', 'denied', 'timed_out'])
      .describe('Outcome: granted proceeds, denied/timed_out abort.'),
    decided_at: z.string().datetime().describe('ISO-8601 UTC timestamp of the decision.'),
    decided_by: ConfirmationDecidedBy.describe('Provenance of the decision — never agent.'),
  })
  .describe('Terminal resolution of a ConfirmationRequest — always human-originated.');

export type ConfirmationDecision = z.infer<typeof ConfirmationDecision>;
