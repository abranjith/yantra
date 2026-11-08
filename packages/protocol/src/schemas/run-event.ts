import { z } from 'zod';

import {
  AGENT_PROGRESS_KINDS,
  agentProgressVariant,
  type AgentProgressEvent,
  type AgentProgressKind,
  type Frozen,
} from './agent-progress.js';
import { ConfirmationDecidedBy, ConfirmationRequest } from './confirmation.js';
import { TaskEvent } from './events.js';
import { FailureClass } from './security.js';
import { TaskOutcome, TerminationReason } from './task-outcome.js';

/**
 * The unified run-event stream (FEAT-063).
 *
 * Every Yantra run, whatever started it, writes one ordered, sequence-numbered
 * record of what happened while it ran: `<runDir>/run-events.jsonl`. Each line
 * is a {@link RunEventRecord} envelope holding one {@link RunEvent}. The CLI's
 * terminal and `--json` renderers, the app's run socket, and any future
 * connector read this one contract.
 *
 * Every text field is bounded and comes from an already-sanitized source;
 * nothing here carries a secret, a resolved placeholder, raw page text, a full
 * URL with query or userinfo, an environment value, a token or a frame.
 */

/** Envelope version written by this executable; readers reject other majors. */
export const RUN_EVENTS_SCHEMA_VERSION = '1' as const;

/**
 * Largest serialized line (UTF-8 bytes, newline included). The writer
 * substitutes `event_omitted` for anything larger, which keeps every record
 * well under the 1 MiB socket message cap.
 */
export const MAX_RUN_EVENT_LINE_BYTES = 262_144;

/**
 * Goal-echo display bound. The echo shows at most 200 goal characters, but
 * each may be escaped (`\"`, `\\`) or a surrogate pair, plus the `goal: "…"`
 * frame and the `(N characters received)` suffix.
 */
export const GOAL_ECHO_DISPLAY_MAX = 512;
/** Advisory warning text bound. */
export const RUN_WARNING_TEXT_MAX = 1_000;
/** Search query bound in a phase event. */
export const PHASE_QUERY_MAX = 200;
/** Display URL bound in a phase event. */
export const PHASE_URL_MAX = 300;
/** Run-relative artifact path bound. */
export const ARTIFACT_PATH_MAX = 300;
/** Most budget dimensions in one snapshot. */
export const BUDGET_DIMENSIONS_MAX = 16;

// C0/C1 control characters and DEL: never stored in a text field.
// eslint-disable-next-line no-control-regex -- matching control characters is the point.
const CONTROL_RE = /[\u0000-\u001F\u007F-\u009F]/u;

const At = z.string().datetime().describe('ISO-8601 UTC timestamp of emission.');

function controlFree(max: number, description: string): z.ZodEffects<z.ZodString> {
  return z
    .string()
    .max(max)
    .refine((value) => !CONTROL_RE.test(value), 'Must not contain control characters.')
    .describe(description);
}

function token(max: number, description: string): z.ZodString {
  return z
    .string()
    .regex(
      new RegExp(`^[a-z][a-z0-9_]{0,${max - 1}}$`, 'u'),
      `Must be a snake_case token of at most ${max} characters.`,
    )
    .describe(description);
}

const HopIndex = z
  .number()
  .int()
  .positive()
  .nullable()
  .describe('1-based research hop, or null for `ask` (a single pass).');

/** A run-relative POSIX path: no `..` segment, no leading `/`, no backslash, no drive. */
export const RunRelativePath = z
  .string()
  .min(1)
  .max(ARTIFACT_PATH_MAX)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.includes('\\') &&
      !/^[A-Za-z]:/u.test(value) &&
      !value.split('/').includes('..') &&
      !CONTROL_RE.test(value),
    'Must be a forward-slash path relative to the run directory, without `..`.',
  )
  .describe('Run-relative POSIX path of a file inside the run directory.');

const newVariants = [
  z.object({
    kind: z.literal('goal_echo').describe('The goal exactly as the run received it (redacted).'),
    display: controlFree(
      GOAL_ECHO_DISPLAY_MAX,
      'The echo line without its newline, e.g. `goal: "…"` or `goal: [not shown: …]`; already redacted and control-stripped.',
    ),
    received_chars: z.number().int().nonnegative().describe('Characters of goal received.'),
    truncated: z.boolean().describe('Whether the display shows only the start of the goal.'),
    at: At,
  }),
  z.object({
    kind: z.literal('run_warning').describe('A `warning: …` advisory the run printed.'),
    source: z
      .enum(['command', 'agent'])
      .describe('command: the CLI command raised it; agent: the agent runtime raised it.'),
    text: controlFree(RUN_WARNING_TEXT_MAX, 'Advisory text without the `warning: ` prefix.'),
    at: At,
  }),
  z.object({
    kind: z.literal('receipt_written').describe('The execution receipt was written (FEAT-072).'),
    path: z
      .string()
      .regex(/^execution-receipt(?:\.resume-[1-9]\d*)?\.json$/u)
      .describe(
        'Run-relative receipt file: `execution-receipt.json`, or `execution-receipt.resume-<n>.json` for the n-th resume.',
      ),
    sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/u)
      .describe('Lowercase hex SHA-256 of the receipt file bytes.'),
    at: At,
  }),
  z.object({
    kind: z.literal('budget_snapshot').describe('What the run has spent against its budgets.'),
    dimensions: z
      .array(
        z.object({
          name: token(48, 'Budget dimension, such as `elapsed`, `tool_calls` or `hops`.'),
          used: z.number().nonnegative().describe('Amount spent so far.'),
          limit: z.number().nonnegative().nullable().describe('The limit, or null if unbounded.'),
          unit: z.enum(['ms', 'count', 'bytes', 'pixels']).describe('Unit of `used` and `limit`.'),
        }),
      )
      .max(BUDGET_DIMENSIONS_MAX)
      .describe('Budget dimensions, at most 16.'),
    at: At,
  }),
  z.object({
    kind: z.literal('artifact_saved').describe('The run saved a file into its run directory.'),
    path: RunRelativePath,
    artifact_kind: z
      .enum(['brief', 'report', 'templated_report', 'screenshot', 'output', 'result', 'other'])
      .describe('What the file is.'),
    media_type: z.string().min(1).max(100).describe('IANA media type of the file.'),
    bytes: z.number().int().nonnegative().nullable().describe('File size, or null if unknown.'),
    at: At,
  }),
  z.object({
    kind: z
      .literal('intervention_raised')
      .describe('The run is waiting for a person (a consent wait today).'),
    intervention_id: z
      .string()
      .min(1)
      .max(64)
      .describe('The intervention id; for a confirmation, its `confirmation_id`.'),
    intervention_kind: z
      .enum(['confirmation'])
      .describe('What the person is asked for; FEAT-068 extends this additively.'),
    request: ConfirmationRequest.describe('The sanitized confirmation request.'),
    deadline_at: z
      .string()
      .datetime()
      .nullable()
      .describe('Absolute instant the wait ends, or null when it waits indefinitely.'),
    at: At,
  }),
  z.object({
    kind: z.literal('intervention_resolved').describe('A person (or the timeout) ended the wait.'),
    intervention_id: z.string().min(1).max(64).describe('The intervention that was resolved.'),
    decision: z.enum(['granted', 'denied', 'timed_out']).describe('How the wait ended.'),
    decided_by: ConfirmationDecidedBy.describe('Who or what resolved it — never agent.'),
    decided_at: z.string().datetime().describe('ISO-8601 UTC timestamp of the decision.'),
    at: At,
  }),
  z.object({
    kind: z.literal('run_outcome').describe('How the run ended: exactly one, the last event.'),
    run_id: z.string().min(1).describe('The run that ended.'),
    task_outcome: TaskOutcome.describe('Whether the task was done.'),
    termination_reason: TerminationReason.nullable().describe(
      'Why an agentic run stopped, or null for a deterministic run.',
    ),
    stop_detail: token(64, 'Command-specific stop detail, such as research `max_hops`.')
      .nullable()
      .describe('Command-specific stop detail, such as research `max_hops`, or null.'),
    exit_code: z.number().int().describe('The process exit code the run reports.'),
    failure_class: FailureClass.nullable().describe('Failure category, or null on success.'),
    at: At,
  }),
  z.object({
    kind: z.literal('search_completed').describe('A deterministic search returned.'),
    hop_index: HopIndex,
    provider: token(48, 'Search provider name.'),
    query: controlFree(PHASE_QUERY_MAX, 'The query, redacted and control-stripped, at most 200.'),
    result_count: z.number().int().nonnegative().describe('Results returned.'),
    cached: z.boolean().describe('Whether the answer came from the day cache.'),
    at: At,
  }),
  z.object({
    kind: z.literal('source_fetched').describe('One deterministic source fetch finished.'),
    hop_index: HopIndex,
    source_index: z.number().int().positive().describe('1-based source position in its pass.'),
    url: controlFree(
      PHASE_URL_MAX,
      'Origin plus path only: no userinfo, query or fragment; a credential-shaped path is `<origin>/[redacted]`.',
    ),
    status: z
      .enum(['ok', 'failed', 'blocked', 'skipped'])
      .describe(
        'ok, failed (fetch or extract), blocked (ethics/challenge), or skipped (budget/policy).',
      ),
    failure_class: token(48, 'Failure stage or class.')
      .nullable()
      .describe('Failure stage or class, or null on success.'),
    duration_ms: z.number().int().nonnegative().nullable().describe('Fetch time, or null.'),
    at: At,
  }),
  z.object({
    kind: z.literal('extract_completed').describe('Extraction for a pass finished.'),
    hop_index: HopIndex,
    extracted: z.number().int().nonnegative().describe('Sources extracted.'),
    failed: z.number().int().nonnegative().describe('Sources that failed.'),
    at: At,
  }),
  z.object({
    kind: z
      .literal('synthesize_started')
      .describe('Synthesis began; `synthesis_completed` reports the end.'),
    strategy: z.enum(['deterministic', 'llm']).describe('Synthesis strategy.'),
    sources_in: z.number().int().nonnegative().describe('Sources fed into synthesis.'),
    at: At,
  }),
  z.object({
    kind: z
      .literal('event_omitted')
      .describe('An event too large for one line was replaced by this marker.'),
    original_kind: z.string().min(1).max(64).describe('The kind of the omitted event.'),
    bytes: z.number().int().nonnegative().describe('Serialized size of the omitted line.'),
    at: At,
  }),
] as const;

/** One event of a run: a task lifecycle event, agent progress, or a run-level fact. */
export const RunEvent = z
  .discriminatedUnion('kind', [
    ...TaskEvent.options,
    agentProgressVariant('kind', 'recovery'),
    agentProgressVariant('kind', 'progress'),
    agentProgressVariant('kind', 'assistant_text'),
    agentProgressVariant('kind', 'tool_started'),
    agentProgressVariant('kind', 'tool_finished'),
    agentProgressVariant('kind', 'contract_declared'),
    agentProgressVariant('kind', 'capability_gap'),
    ...newVariants,
  ])
  .describe('One run event, discriminated by `kind`.');

export type RunEvent = Frozen<z.infer<typeof RunEvent>>;
export type RunEventKind = RunEvent['kind'];
/** The `RunEvent` variant of one kind. */
export type RunEventOf<K extends RunEventKind> = Extract<RunEvent, { readonly kind: K }>;

/** One line of `run-events.jsonl`, and the payload of a run-socket `event` message. */
export const RunEventRecord = z
  .object({
    schema_version: z
      .literal(RUN_EVENTS_SCHEMA_VERSION)
      .describe('Envelope version; a reader rejects an unknown major.'),
    seq: z
      .number()
      .int()
      .positive()
      .describe('Gap-free, strictly increasing sequence number, assigned by the writer.'),
    run_id: z.string().min(1).describe('The owning run.'),
    event: RunEvent,
  })
  .describe('One sequence-numbered run event, as written to run-events.jsonl.');

export type RunEventRecord = Frozen<z.infer<typeof RunEventRecord>>;

/** Every `RunEvent` kind, in union order (FEAT-070 builds parity over this tuple). */
export const RUN_EVENT_KINDS = [
  'task_queued',
  'task_started',
  'step_started',
  'step_retry',
  'step_completed',
  'llm_step_skipped',
  'checkpoint_saved',
  'human_handoff_requested',
  'task_completed',
  'task_failed',
  'validation_failed',
  'scope_violation',
  'task_resumed',
  'chrome_drift_warning',
  'synthesis_completed',
  'research_hop_completed',
  'confirmation_requested',
  'confirmation_resolved',
  'discovery_cycle_completed',
  'discovery_session_completed',
  'recovery',
  'progress',
  'assistant_text',
  'tool_started',
  'tool_finished',
  'contract_declared',
  'capability_gap',
  'goal_echo',
  'run_warning',
  'receipt_written',
  'budget_snapshot',
  'artifact_saved',
  'intervention_raised',
  'intervention_resolved',
  'run_outcome',
  'search_completed',
  'source_fetched',
  'extract_completed',
  'synthesize_started',
  'event_omitted',
] as const satisfies readonly RunEventKind[];

/** Kinds that change whether the run is waiting for a person; each forces a sync. */
export const INTERVENTION_EVENT_KINDS = [
  'intervention_raised',
  'intervention_resolved',
  'confirmation_requested',
  'confirmation_resolved',
  'human_handoff_requested',
] as const satisfies readonly RunEventKind[];

/** Kinds that end a run or its task; each forces a sync. */
export const TERMINAL_EVENT_KINDS = [
  'run_outcome',
  'task_completed',
  'task_failed',
] as const satisfies readonly RunEventKind[];

const KNOWN_KINDS: ReadonlySet<string> = new Set(RUN_EVENT_KINDS);
const AGENT_KINDS: ReadonlySet<string> = new Set(AGENT_PROGRESS_KINDS);

/** Whether `kind` is a kind this executable knows. */
export function isRunEventKind(kind: string): kind is RunEventKind {
  return KNOWN_KINDS.has(kind);
}

/** Whether a run event is one of the agent progress variants. */
export function isAgentProgressRunEvent(event: RunEvent): event is RunEventOf<AgentProgressKind> {
  return AGENT_KINDS.has(event.kind);
}

/**
 * The `RunEvent` for an agent progress event: `type` renamed to `kind`, every
 * other key kept in order, so `--json` bytes survive the round trip.
 */
export function toRunEvent(event: AgentProgressEvent): RunEvent {
  const { type, ...rest } = event;
  return { kind: type, ...rest } as RunEvent;
}

/** The connector-shaped agent progress event, or null for any other kind. */
export function toAgentProgressEvent(event: RunEvent): AgentProgressEvent | null {
  if (!isAgentProgressRunEvent(event)) return null;
  const { kind, ...rest } = event;
  return { type: kind, ...rest } as AgentProgressEvent;
}

/**
 * The value an in-process subscriber receives (never persisted). `seq` is null
 * only for a delivery made before the log opened or after it degraded;
 * `committed` is true exactly when the line was appended before delivery.
 */
export interface RunEventDelivery {
  readonly seq: number | null;
  readonly committed: boolean;
  readonly event: RunEvent;
}

/** One item a `run-events.jsonl` reader yields. */
export type RunEventReadItem =
  | { readonly status: 'event'; readonly record: RunEventRecord }
  /** A well-formed envelope from a newer writer; shown by a generic inspector, never an error. */
  | {
      readonly status: 'unknown_kind';
      readonly seq: number;
      readonly kind: string;
      readonly raw: Readonly<Record<string, unknown>>;
    }
  /** A complete line that is not a valid envelope; skipped and reported. */
  | { readonly status: 'invalid'; readonly line: string; readonly reason: string };

const Envelope = z.object({
  schema_version: z.literal(RUN_EVENTS_SCHEMA_VERSION),
  seq: z.number().int().positive(),
  run_id: z.string().min(1),
  event: z.object({ kind: z.string().min(1) }).passthrough(),
});

/** Most characters of a bad line kept in an `invalid` item. */
const INVALID_LINE_EXCERPT = 200;

/**
 * Classifies one complete `run-events.jsonl` line (without its newline).
 *
 * - not JSON, or not a known envelope → `invalid`;
 * - a known envelope whose `event.kind` this executable does not know →
 *   `unknown_kind` (a newer writer; never an error);
 * - a known kind whose fields fail validation → `invalid`.
 */
export function parseRunEventLine(line: string): RunEventReadItem {
  const excerpt =
    line.length > INVALID_LINE_EXCERPT ? `${line.slice(0, INVALID_LINE_EXCERPT)}…` : line;
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return { status: 'invalid', line: excerpt, reason: 'not JSON' };
  }
  const envelope = Envelope.safeParse(json);
  if (!envelope.success) {
    return {
      status: 'invalid',
      line: excerpt,
      reason: `bad envelope: ${firstIssue(envelope.error)}`,
    };
  }
  const kind = envelope.data.event.kind;
  if (!isRunEventKind(kind)) {
    return {
      status: 'unknown_kind',
      seq: envelope.data.seq,
      kind,
      raw: envelope.data.event,
    };
  }
  const record = RunEventRecord.safeParse(json);
  if (!record.success) {
    return {
      status: 'invalid',
      line: excerpt,
      reason: `bad ${kind} event: ${firstIssue(record.error)}`,
    };
  }
  return { status: 'event', record: record.data };
}

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return 'invalid';
  return issue.path.length === 0 ? issue.message : `${issue.path.join('.')}: ${issue.message}`;
}
