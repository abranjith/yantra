import { z } from 'zod';

import { ULID_PATTERN } from '../utils/ulid.js';

import {
  CONFIRMABLE_ACTION_KINDS,
  ConfirmationDecidedBy,
  ConfirmationDecision,
  ConfirmationRequest,
} from './confirmation.js';

/**
 * Interventions, decision authority responses, parked-decision claims,
 * notification attempts, and the Inbox read model (FEAT-068).
 */

/** Default cumulative unattended wait ceiling per run (15 minutes in ms). */
export const UNATTENDED_CEILING_DEFAULT_MS = 900_000 as const;

/** Maximum length for intervention handoff text fields. */
export const INTERVENTION_HANDOFF_TEXT_MAX = 300 as const;
/** Maximum length for missing-input labels. */
export const INTERVENTION_MISSING_LABEL_MAX = 120 as const;
/** Maximum length for missing-input reasons. */
export const INTERVENTION_MISSING_REASON_MAX = 200 as const;
/** Maximum number of missing-input entries on one intervention. */
export const INTERVENTION_MISSING_MAX_ITEMS = 20 as const;
/** Maximum length for an InboxItem title. */
export const INBOX_TITLE_MAX = 300 as const;

// eslint-disable-next-line no-control-regex -- reject raw ANSI escape bytes
const ANSI_ESCAPE_PATTERN = /[\u001b\u009b]/;
const ANSI_MESSAGE = 'must not contain raw ANSI escape bytes (\\u001b or \\u009b)';
const noAnsi = (value: string): boolean => !ANSI_ESCAPE_PATTERN.test(value);

/** Kind of human-facing intervention raised during or at the end of a run. */
export const InterventionKind = z
  .enum(['consent', 'handoff', 'input', 'takeover'])
  .describe(
    'Intervention kind: consent (live or parked approval), handoff (terminal blocker), input (missing requirements from partial brief), takeover (Phase 2 schema, resolves as handoff in MVP).',
  );
export type InterventionKind = z.infer<typeof InterventionKind>;

/** Lifecycle state of an intervention. */
export const InterventionState = z
  .enum(['pending', 'granted', 'denied', 'timed_out', 'recorded'])
  .describe(
    'Lifecycle state: pending -> granted | denied | timed_out for consent; recorded for informational handoff/input/takeover items.',
  );
export type InterventionState = z.infer<typeof InterventionState>;

/** Which deadline bound produced an intervention's `attended_deadline_at`. */
export const DeadlineBasis = z
  .enum(['request_timeout', 'agent_confirm_timeout', 'wall_clock', 'none'])
  .describe('Which deadline bound produced attended_deadline_at while attending.');
export type DeadlineBasis = z.infer<typeof DeadlineBasis>;

/** Handoff blocker and safest next action for `handoff` and `takeover` interventions. */
export const InterventionHandoff = z
  .object({
    blocker: z
      .string()
      .min(1)
      .max(INTERVENTION_HANDOFF_TEXT_MAX)
      .refine(noAnsi, ANSI_MESSAGE)
      .describe('Plain sanitized blocker description without ANSI escapes.'),
    safest_next_action: z
      .string()
      .min(1)
      .max(INTERVENTION_HANDOFF_TEXT_MAX)
      .refine(noAnsi, ANSI_MESSAGE)
      .describe('Plain sanitized safest next action without ANSI escapes.'),
  })
  .strict()
  .describe('Plain sanitized blocker and safest next action for a handoff or takeover.');
export type InterventionHandoff = z.infer<typeof InterventionHandoff>;

/** One unmet requirement item surfaced by an `input` intervention. */
export const InterventionMissingItem = z
  .object({
    label: z
      .string()
      .min(1)
      .max(INTERVENTION_MISSING_LABEL_MAX)
      .refine(noAnsi, ANSI_MESSAGE)
      .describe('Sanitized requirement label.'),
    reason: z
      .string()
      .min(1)
      .max(INTERVENTION_MISSING_REASON_MAX)
      .refine(noAnsi, ANSI_MESSAGE)
      .nullable()
      .describe('Sanitized reason the requirement went unmet, or null.'),
  })
  .strict()
  .describe('Missing input requirement item captured from a partial run brief.');
export type InterventionMissingItem = z.infer<typeof InterventionMissingItem>;

/** Recovery action an Intervention supports in the Inbox. */
export const InterventionRecovery = z
  .enum(['resume', 'run_again', 'none'])
  .describe('Recovery action available for this intervention from core resumability.');
export type InterventionRecovery = z.infer<typeof InterventionRecovery>;

/** One human-facing intervention record (`runs/<id>/interventions.jsonl`). */
export const Intervention = z
  .object({
    intervention_id: z
      .string()
      .regex(ULID_PATTERN)
      .describe('ULID identifying the intervention; equals confirmation_id for consent.'),
    run_id: z.string().min(1).describe('Owning run identifier.'),
    kind: InterventionKind.describe('Intervention kind.'),
    state: InterventionState.describe('Current state of the intervention.'),
    raised_at: z.string().datetime().describe('ISO-8601 UTC timestamp when raised.'),
    request: ConfirmationRequest.nullable()
      .optional()
      .describe('ConfirmationRequest payload; required when kind is consent.'),
    attended_deadline_at: z
      .string()
      .datetime()
      .nullable()
      .optional()
      .describe(
        'Authoritative attended deadline ISO timestamp, or null when unbounded while attended.',
      ),
    deadline_basis: DeadlineBasis.nullable()
      .optional()
      .describe('Which bound produced attended_deadline_at; required when kind is consent.'),
    unattended_ceiling_ms: z
      .number()
      .int()
      .positive()
      .nullable()
      .optional()
      .describe('Cumulative unattended ceiling in ms (default 900000); required for consent.'),
    unattended_accrued_ms: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .optional()
      .describe('Run-level unattended wait accrued at raise time; required for consent.'),
    handoff: InterventionHandoff.nullable()
      .optional()
      .describe('Blocker and safest next action; required when kind is handoff or takeover.'),
    missing: z
      .array(InterventionMissingItem)
      .max(INTERVENTION_MISSING_MAX_ITEMS)
      .nullable()
      .optional()
      .describe('Unmet input items (up to 20); required when kind is input.'),
    recovery: InterventionRecovery.describe('Recovery action offered by the Inbox.'),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.kind === 'consent') {
      if (value.request == null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['request'],
          message: 'consent intervention requires a non-null request',
        });
      }
      if (value.attended_deadline_at === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['attended_deadline_at'],
          message: 'consent intervention requires attended_deadline_at (ISO datetime or null)',
        });
      }
      if (value.deadline_basis == null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['deadline_basis'],
          message: 'consent intervention requires deadline_basis',
        });
      }
      if (value.unattended_ceiling_ms == null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['unattended_ceiling_ms'],
          message: 'consent intervention requires unattended_ceiling_ms',
        });
      }
      if (value.unattended_accrued_ms == null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['unattended_accrued_ms'],
          message: 'consent intervention requires unattended_accrued_ms',
        });
      }
      if (value.state === 'recorded') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['state'],
          message: 'consent intervention state must be pending, granted, denied, or timed_out',
        });
      }
      return;
    }

    if (value.state !== 'recorded') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['state'],
        message: `${value.kind} intervention state must be recorded`,
      });
    }

    if ((value.kind === 'handoff' || value.kind === 'takeover') && value.handoff == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['handoff'],
        message: `${value.kind} intervention requires handoff`,
      });
    }

    if (value.kind === 'input' && value.missing == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['missing'],
        message: 'input intervention requires missing',
      });
    }
  })
  .describe('Human-facing intervention raised during or at the end of a run.');
export type Intervention = z.infer<typeof Intervention>;

/** Why a pending consent intervention was resolved. */
export const InterventionResolutionReason = z
  .enum([
    'answered',
    'request_timeout',
    'agent_confirm_timeout',
    'wall_clock',
    'unattended',
    'run_ended',
  ])
  .describe('Cause of consent resolution.');
export type InterventionResolutionReason = z.infer<typeof InterventionResolutionReason>;

/** One JSONL line of `runs/<id>/interventions.jsonl`. */
export const InterventionLogEntry = z
  .discriminatedUnion('entry', [
    z
      .object({
        entry: z.literal('raised'),
        intervention: Intervention.describe('The raised intervention.'),
      })
      .strict()
      .describe('Recorded when an intervention is raised.'),
    z
      .object({
        entry: z.literal('resolved'),
        intervention_id: z.string().regex(ULID_PATTERN).describe('Resolved intervention ULID.'),
        decision: ConfirmationDecision.describe('Authoritative decision record.'),
        reason: InterventionResolutionReason.describe('Why the wait resolved.'),
        waited_ms: z
          .number()
          .int()
          .nonnegative()
          .describe('Wall-clock milliseconds elapsed while waiting.'),
        unattended_accrued_ms: z
          .number()
          .int()
          .nonnegative()
          .describe('Cumulative run-level unattended milliseconds after resolution.'),
      })
      .strict()
      .describe('Recorded when a consent intervention resolves (at most once per id).'),
    z
      .object({
        entry: z.literal('attendance'),
        count: z.number().int().nonnegative().describe('Attending window/terminal count.'),
        at: z.string().datetime().describe('ISO-8601 UTC timestamp of transition.'),
      })
      .strict()
      .describe('Recorded when attendance crosses zero while a consent is pending.'),
  ])
  .describe('One entry in runs/<id>/interventions.jsonl.');
export type InterventionLogEntry = z.infer<typeof InterventionLogEntry>;

/** Defined reply from the decision authority or parked-claim service (D12). */
export const DecisionResponse = z
  .discriminatedUnion('status', [
    z
      .object({
        status: z.literal('accepted'),
        decision: ConfirmationDecision.describe('The accepted decision.'),
      })
      .strict()
      .describe('This caller won the atomic decision transition.'),
    z
      .object({
        status: z.literal('already_decided'),
        decision: z.enum(['granted', 'denied', 'timed_out']).describe('Prior decision value.'),
        decided_by: ConfirmationDecidedBy.describe('Provenance of the winning decision.'),
        decided_at: z.string().datetime().describe('ISO-8601 UTC timestamp of the winning answer.'),
      })
      .strict()
      .describe('The request was already resolved by another caller or a prior delivery.'),
    z
      .object({
        status: z.literal('expired'),
        decided_at: z.string().datetime().describe('ISO-8601 UTC timestamp when it expired.'),
      })
      .strict()
      .describe('The deadline had already passed when the answer arrived.'),
    z
      .object({
        status: z.literal('stale'),
        reason: z
          .enum(['unknown_id', 'earlier_attempt', 'not_waiting'])
          .describe('Why the run is no longer waiting for this id.'),
      })
      .strict()
      .describe('The run is not waiting for this intervention id.'),
  ])
  .describe('Authoritative response returned to every confirmation answer path.');
export type DecisionResponse = z.infer<typeof DecisionResponse>;

/** Action-binding tuple copied from a ConfirmationRequest onto a parked claim (D12). */
export const ConfirmationBinding = z
  .object({
    run_id: z.string().min(1).describe('Bound run id.'),
    step_id: z.string().min(1).describe('Bound step id.'),
    action_kind: z.enum(CONFIRMABLE_ACTION_KINDS).describe('Bound confirmable verb.'),
    target_host: z
      .string()
      .min(1)
      .nullable()
      .describe('Normalized lowercase hostname without port, or null if absent.'),
    plan_digest: z
      .string()
      .regex(/^[0-9a-f]{64}$/u)
      .nullable()
      .describe('SHA-256 of canonical plan JSON, or null for legacy/agentic requests.'),
    step_digest: z
      .string()
      .regex(/^[0-9a-f]{64}$/u)
      .nullable()
      .describe('SHA-256 of canonical step JSON, or null for legacy/agentic requests.'),
  })
  .strict()
  .describe('Six-field action-binding tuple for parked confirmation replay verification.');
export type ConfirmationBinding = z.infer<typeof ConfirmationBinding>;

/** Exclusive file claim (`runs/<id>/decisions/<confirmation_id>.json`) for parked runs. */
export const ParkedDecisionClaim = z
  .object({
    schema_version: z.literal(1).describe('Claim file schema version.'),
    confirmation_id: z.string().regex(ULID_PATTERN).describe('Resolved request ULID.'),
    run_id: z.string().min(1).describe('Owning run id.'),
    decision: z.enum(['granted', 'denied']).describe('Human parked decision.'),
    decided_by: z
      .enum(['user_cli_confirm', 'user_app'])
      .describe('Human surface that claimed the decision.'),
    decided_at: z.string().datetime().describe('ISO-8601 UTC timestamp of claim creation.'),
    binding: ConfirmationBinding.describe('Action binding copied from the pending request.'),
  })
  .strict()
  .describe('Atomic exclusive claim file deciding a parked confirmation request.');
export type ParkedDecisionClaim = z.infer<typeof ParkedDecisionClaim>;

/** Delivery channel for a tracked notification attempt. */
export const NotificationAttemptChannel = z
  .enum(['app', 'desktop'])
  .describe('Notification delivery channel.');
export type NotificationAttemptChannel = z.infer<typeof NotificationAttemptChannel>;

/** Outcome status of a notification delivery attempt. */
export const NotificationAttemptStatus = z
  .enum(['attempted', 'delivered', 'failed', 'unsupported'])
  .describe('Tracked notification delivery state.');
export type NotificationAttemptStatus = z.infer<typeof NotificationAttemptStatus>;

/** Closed detail reason for non-delivered notification attempts (never free text). */
export const NotificationAttemptDetail = z
  .enum(['no_window', 'send_error', 'spawn_error', 'nonzero_exit', 'platform_unsupported'])
  .describe('Closed-enum failure or unsupported reason for a notification attempt.');
export type NotificationAttemptDetail = z.infer<typeof NotificationAttemptDetail>;

/** Attempt line appended to `<data-dir>/notifications.jsonl` (`record: 'attempt'`). */
export const NotificationAttempt = z
  .object({
    record: z.literal('attempt'),
    attempt_id: z.string().regex(ULID_PATTERN).describe('ULID of this delivery attempt.'),
    notification_id: z
      .string()
      .regex(ULID_PATTERN)
      .nullable()
      .describe('Notification line ULID for desktop attempts, or null for app attempts.'),
    intervention_id: z
      .string()
      .regex(ULID_PATTERN)
      .describe('Intervention that triggered this notification attempt.'),
    run_id: z.string().min(1).describe('Owning run id.'),
    channel: NotificationAttemptChannel.describe('Channel attempted.'),
    status: NotificationAttemptStatus.describe('Outcome of the attempt.'),
    at: z.string().datetime().describe('ISO-8601 UTC timestamp of the attempt event.'),
    detail: NotificationAttemptDetail.nullable().describe(
      'Closed-enum detail when failed or unsupported, otherwise null.',
    ),
  })
  .strict()
  .describe('Tracked notification delivery attempt record.');
export type NotificationAttempt = z.infer<typeof NotificationAttempt>;

/** Category of an InboxItem in the app Inbox read model. */
export const InboxItemKind = z
  .enum([
    'consent_live',
    'consent_parked',
    'expired',
    'handoff',
    'input',
    'needs_review',
    'start_unknown',
  ])
  .describe('Classification of an Inbox item.');
export type InboxItemKind = z.infer<typeof InboxItemKind>;

/** Recovery action surfaced on an InboxItem. */
export const InboxRecovery = z
  .enum(['resume', 'run_again', 'run_again_with_input', 'none'])
  .describe('Recovery action offered by the Inbox item.');
export type InboxRecovery = z.infer<typeof InboxRecovery>;

/** Derived Inbox item returned by `read.inbox` (not persisted directly). */
export const InboxItem = z
  .object({
    item_id: z
      .string()
      .min(1)
      .describe('Stable identifier: intervention:<id>, parked:<run>:<cid>, or invocation:<id>.'),
    kind: InboxItemKind.describe('Item classification.'),
    run_id: z.string().min(1).nullable().describe('Associated run id, or null.'),
    invocation_id: z.string().min(1).nullable().describe('Associated invocation id, or null.'),
    title: z
      .string()
      .min(1)
      .max(INBOX_TITLE_MAX)
      .refine(noAnsi, ANSI_MESSAGE)
      .describe('Protocol words title without ANSI escapes.'),
    raised_at: z.string().datetime().describe('ISO-8601 UTC timestamp used for ordering.'),
    intervention: Intervention.nullable().describe('Backing intervention record, or null.'),
    recovery: InboxRecovery.describe('Recovery action available for this item.'),
    dismissible: z
      .boolean()
      .describe('True for informational items; always false for pending consents.'),
  })
  .strict()
  .describe('Read-model entry surfaced in the app Inbox.');
export type InboxItem = z.infer<typeof InboxItem>;

/** One dismissal line in `<data-dir>/ui/inbox-dismissed.jsonl`. */
export const InboxDismissal = z
  .object({
    item_id: z.string().min(1).describe('Dismissed Inbox item id.'),
    dismissed_at: z.string().datetime().describe('ISO-8601 UTC timestamp of dismissal.'),
  })
  .strict()
  .describe('App presentation dismissal entry in ui/inbox-dismissed.jsonl.');
export type InboxDismissal = z.infer<typeof InboxDismissal>;
