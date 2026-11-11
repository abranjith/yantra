import { z } from 'zod';

import { expandOptions } from '../commands/expand.js';
import { CommandInvocation } from '../commands/invocation.js';
import { COMMAND_REGISTRY } from '../commands/registry.js';
import { JsonValue, type CommandRegistry } from '../commands/schema.js';

import { ContentIdentitySchema, ReceiptSettingSchema } from './execution-receipt.js';
import { WorkerResult } from './run-channel.js';
import { ProcessIdentityRecord, RUN_TOKEN_PATTERN } from './run-lease.js';

/**
 * The app host's durable records (FEAT-065, plan_ui D1–D6, D11, D13).
 *
 * Every record here is a file under `<data-dir>/ui/`, written atomically and
 * owner-only. The host is a supervisor, never an executor: these records say
 * who owns what, never how a task runs.
 */

/** The app host ↔ app protocol version this executable speaks (D17). */
export const APP_CHANNEL_VERSION = 1 as const;

const isoDateTime = z.string().datetime({ offset: true });

/** `<data-dir>/ui/host.lock`: the single-instance app host record. */
export const HostLockRecord = z
  .object({
    schema_version: z.literal(1).describe('Record format version.'),
    state: z
      .enum(['starting', 'ready'])
      .describe('`starting` from acquisition until both listeners are bound, then `ready`.'),
    pid: z.number().int().positive().describe('Host process ID.'),
    start_token: z.string().min(1).describe('Host process creation token.'),
    port: z
      .number()
      .int()
      .min(1)
      .max(65_535)
      .nullable()
      .describe('Loopback HTTP port; set when `ready`.'),
    control_socket: z
      .string()
      .min(1)
      .nullable()
      .describe('Control socket path (POSIX) or named-pipe name (Windows); set when `ready`.'),
    control_token: z
      .string()
      .regex(RUN_TOKEN_PATTERN)
      .describe('256-bit base64url token a control client must send first.'),
    build_id: z.string().min(1).describe('ID of the embedded web build the host serves.'),
    yantra_version: z
      .string()
      .min(1)
      .describe('Version of the Yantra executable running the host.'),
    channel_version: z.number().int().positive().describe('App channel version (D17).'),
    started_at: isoDateTime.describe('When the host acquired the lock.'),
    env_captured_at: isoDateTime.describe(
      'When the host captured the environment it gives workers (D13).',
    ),
  })
  .strict()
  .refine((record) => record.state === 'starting' || record.port !== null, {
    message: 'A ready host records its port',
    path: ['port'],
  })
  .describe('The single-instance app host lock, one per data directory.');
export type HostLockRecord = z.infer<typeof HostLockRecord>;

/** Pattern of a client-generated invocation idempotency key. */
export const INVOCATION_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/u;

/** Every state an app-launched invocation can be in (D11). */
export const InvocationState = z
  .enum([
    'queued',
    'reserved',
    'spawning',
    'claimed',
    'running',
    'finished',
    'never_started',
    'start_unknown',
    'needs_review',
    'discarded',
  ])
  .describe('Launch-ownership state of one app invocation.');
export type InvocationState = z.infer<typeof InvocationState>;

/** Execution classes the app host launches as workers. */
export const WorkerExecutionClass = z
  .enum(['run', 'mutate', 'exclusive'])
  .describe('`run` holds a slot, `exclusive` needs zero runs, `mutate` holds none.');
export type WorkerExecutionClass = z.infer<typeof WorkerExecutionClass>;

/**
 * Option attributes whose registry input kind is `secret-input`. Their values
 * are never displayed, stored or compared (plan §7).
 */
export function secretSettingKeys(registry: CommandRegistry = COMMAND_REGISTRY): Set<string> {
  const keys = new Set<string>();
  for (const entry of registry.commands) {
    if (entry.kind !== 'leaf') continue;
    for (const option of expandOptions(entry, registry.option_groups)) {
      if (option.input.kind === 'secret-input') keys.add(option.attribute);
    }
    for (const argument of entry.arguments) {
      if (argument.input.kind === 'secret-input') keys.add(argument.name);
    }
  }
  return keys;
}

/**
 * Builds the {@link DisplayedEffective} schema refusing `secretKeys`.
 * Exported so a test can prove the refusal with a key the shipped registry
 * does not mark secret.
 */
export function displayedEffectiveSchema(secretKeys: ReadonlySet<string>) {
  return z
    .object({
      settings: z
        .array(ReceiptSettingSchema)
        .describe('Effective non-secret settings the composer showed, with their sources.'),
      content: z
        .array(ContentIdentitySchema)
        .describe('Workflow and template content identities the composer showed.'),
    })
    .strict()
    .superRefine((value, context) => {
      value.settings.forEach((setting, index) => {
        if (secretKeys.has(setting.key)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: `"${setting.key}" is a secret input and is never recorded`,
            path: ['settings', index, 'key'],
          });
        }
      });
    })
    .describe(
      'What the composer showed at submission (D13): the baseline for queue drift review. Never holds a secret.',
    );
}

/** The effective settings and content identities shown at submission (D13). */
export const DisplayedEffective = displayedEffectiveSchema(secretSettingKeys());
export type DisplayedEffective = z.infer<typeof DisplayedEffective>;

/** One difference found by queue drift review (TASK-017). */
export const DriftDifference = z
  .object({
    key: z.string().min(1).describe('Setting key, or `content:<path>` for a content identity.'),
    submitted: JsonValue.nullable().describe('The value shown at submission.'),
    current: JsonValue.nullable().describe('The value now; null when it no longer exists.'),
    pinnable: z
      .boolean()
      .describe('True when the submitted value can be pinned as an explicit flag.'),
  })
  .strict()
  .describe('One setting or content identity that changed while queued.');
export type DriftDifference = z.infer<typeof DriftDifference>;

/** Why an invocation finished other than by its own completion. */
export const InvocationFinishReason = z
  .enum(['owner_lost', 'busy', 'refused_claim'])
  .describe(
    '`owner_lost`: the worker died and was reconciled; `busy`: the run was owned elsewhere; `refused_claim`: the worker found the item withdrawn.',
  );
export type InvocationFinishReason = z.infer<typeof InvocationFinishReason>;

/** `<data-dir>/ui/invocations/<invocation_id>.json`: one app-launched invocation. */
export const InvocationRecord = z
  .object({
    schema_version: z.literal(1).describe('Record format version.'),
    invocation_id: z
      .string()
      .regex(INVOCATION_ID_PATTERN)
      .describe('Client-generated idempotency key; unique by file name.'),
    invocation: CommandInvocation.describe('What was requested (FEAT-062).'),
    execution_class: WorkerExecutionClass.describe(
      'Execution class resolved from the registry for these options at submission.',
    ),
    state: InvocationState,
    queued_at: isoDateTime.describe('Submission time; FIFO order is by this, then the ID.'),
    updated_at: isoDateTime.describe('Time of the last state change.'),
    displayed_effective: DisplayedEffective,
    run_id: z
      .string()
      .min(1)
      .nullable()
      .describe('Run ID allocated at `reserved` (the existing run for `resume`).'),
    worker: ProcessIdentityRecord.nullable().describe('Set only by the worker, through its claim.'),
    review: z
      .object({
        detected_at: isoDateTime.describe('When drift review found the differences.'),
        differences: z.array(DriftDifference).min(1),
      })
      .strict()
      .nullable()
      .describe('Set on `needs_review`.'),
    duplicate_risk_acknowledged: z
      .boolean()
      .default(false)
      .describe('Must be true to start a `start_unknown` item again.'),
    result: z
      .object({
        exit_code: z.number().int().describe('The command exit code.'),
        finished_at: isoDateTime,
        reason: InvocationFinishReason.optional(),
      })
      .strict()
      .nullable()
      .describe('Set on `finished`.'),
  })
  .strict()
  .refine((record) => record.invocation.invocation_id === record.invocation_id, {
    message: 'invocation.invocation_id must equal invocation_id',
    path: ['invocation', 'invocation_id'],
  })
  .describe('One app-launched invocation and its launch-ownership state (D11).');
export type InvocationRecord = z.infer<typeof InvocationRecord>;
export type InvocationRecordInput = z.input<typeof InvocationRecord>;

/** Largest result envelope kept in an invocation result (1 MiB). */
export const MAX_INVOCATION_ENVELOPE_BYTES = 1_048_576 as const;

/**
 * `<data-dir>/ui/invocations/<invocation_id>.result.json`: the worker's result.
 * It is the FEAT-064 {@link WorkerResult}, written once by the worker's result
 * sink at the launch's `result_path`; an envelope over
 * {@link MAX_INVOCATION_ENVELOPE_BYTES} is replaced by `{truncated, bytes}`.
 */
export const InvocationResult = WorkerResult;
export type InvocationResult = WorkerResult;

/** `yantra ui --json`. */
export const UiOpenResult = z
  .object({
    schemaVersion: z.literal(1).describe('Output format version.'),
    url: z
      .string()
      .regex(/^http:\/\/127\.0\.0\.1:\d+\/#code=[A-Za-z0-9_-]+$/u)
      .describe('The app URL with its single-use launch code in the fragment.'),
    port: z.number().int().min(1).max(65_535).describe('Loopback HTTP port.'),
    hostPid: z.number().int().positive().describe('App host process ID.'),
    reused: z.boolean().describe('True when an already-running host served the request.'),
  })
  .strict()
  .describe('What `yantra ui` opened or printed.');
export type UiOpenResult = z.infer<typeof UiOpenResult>;
