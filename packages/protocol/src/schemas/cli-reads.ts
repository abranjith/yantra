import { z } from 'zod';

import { RunId } from './run-artifacts.js';
import { ExecutionState } from './run-lease.js';
import { TaskOutcome } from './task-outcome.js';

/**
 * `--json` documents of the read-class commands the app renders (FEAT-066):
 * `yantra list` here, `audit` and `report` beside it. The host's `read.*`
 * methods return these exact shapes, extended only by cursors and windows,
 * so the app and the terminal cannot drift.
 */

/**
 * The version every CLI `--json` envelope carries: protocol `SCHEMA_VERSION`,
 * restated because `version.ts` imports schemas (a test pins the two equal).
 */
export const CLI_READ_SCHEMA_VERSION = '0.2' as const;

/** The task verb a run was started with. */
export const LedgerMode = z
  .enum(['ask', 'research', 'do', 'run'])
  .describe('The command that started the run: ask, research, do, or run (a saved workflow).');
export type LedgerMode = z.infer<typeof LedgerMode>;

/** One run in `yantra list --json`. */
export const ListRunItem = z
  .object({
    kind: z.literal('run'),
    runId: z.string().min(1).describe('The run directory name.'),
    workflowName: z
      .string()
      .describe('The workflow name, or the query or goal the run was started with.'),
    status: z
      .string()
      .min(1)
      .describe('The history status or the manifest status, exactly as the CLI prints it.'),
    startedAt: z.string().min(1).describe('ISO-8601 start time.'),
    durationMs: z.number().nullable().describe('Wall-clock duration, or null while unknown.'),
    taskOutcome: TaskOutcome.optional().describe('Present only on runs that recorded one.'),
    executionState: ExecutionState.optional().describe(
      '`interrupted` when the run’s owner died and a reconciler ended it (FEAT-064).',
    ),
    taskType: LedgerMode.optional().describe('Additive (FEAT-066): the command that ran.'),
    costUsd: z
      .number()
      .nullable()
      .optional()
      .describe('Additive (FEAT-066): metered cost in USD, or null when not metered.'),
    hasDocument: z
      .boolean()
      .optional()
      .describe('Additive (FEAT-066): the run saved a Brief or a templated document.'),
  })
  .strict()
  .describe('One run in `yantra list --json`.');
export type ListRunItem = z.infer<typeof ListRunItem>;

/** One saved workflow in `yantra list workflows --json`. */
export const ListWorkflowItem = z
  .object({
    kind: z.literal('workflow'),
    name: z.string().min(1),
    stepCount: z.number().int().nonnegative(),
    securityClass: z.string().min(1),
    modifiedAt: z.string().min(1),
  })
  .strict()
  .describe('One saved workflow in `yantra list workflows --json`.');
export type ListWorkflowItem = z.infer<typeof ListWorkflowItem>;

/** `yantra list --json`. */
export const ListResult = z
  .object({
    schemaVersion: z.literal(CLI_READ_SCHEMA_VERSION),
    kind: z.literal('list'),
    items: z.array(z.union([ListRunItem, ListWorkflowItem])),
  })
  .strict()
  .describe('The `yantra list --json` document.');
export type ListResult = z.infer<typeof ListResult>;

/** A Ledger outcome filter: a task outcome, or `unknown` for runs that recorded none. */
export const LedgerOutcomeFilter = z.union([TaskOutcome, z.literal('unknown')]);
export type LedgerOutcomeFilter = z.infer<typeof LedgerOutcomeFilter>;

/** Default and largest Ledger page sizes. */
export const LEDGER_DEFAULT_LIMIT = 50 as const;
export const LEDGER_MAX_LIMIT = 200 as const;

const isoInstant = z.string().datetime({ offset: true });

/** `read.list` params for target `runs`. */
export const RunLedgerQuery = z
  .object({
    target: z.literal('runs').default('runs'),
    cursor: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .describe('Opaque cursor from a previous page’s `next_cursor`.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(LEDGER_MAX_LIMIT)
      .default(LEDGER_DEFAULT_LIMIT)
      .describe('Page size, 1–200 (default 50).'),
    outcome: z
      .array(LedgerOutcomeFilter)
      .min(1)
      .max(6)
      .optional()
      .describe('Only these outcomes; `unknown` matches runs without one.'),
    mode: z.array(LedgerMode).min(1).max(4).optional().describe('Only these commands.'),
    since: isoInstant.optional().describe('Only runs started at or after this instant.'),
    until: isoInstant.optional().describe('Only runs started before this instant.'),
    text: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe('Case-insensitive substring of the intent text or the run id.'),
    workflow: z.string().min(1).optional().describe('`yantra list --workflow`: exact name.'),
    status: z.string().min(1).optional().describe('`yantra list --status`: exact status word.'),
  })
  .strict()
  .describe('One Ledger page request.');
export type RunLedgerQuery = z.infer<typeof RunLedgerQuery>;

/** `read.list` params for target `workflows`. */
export const WorkflowListQuery = z
  .object({ target: z.literal('workflows') })
  .strict()
  .describe('List saved workflows.');
export type WorkflowListQuery = z.infer<typeof WorkflowListQuery>;

/** `read.list` params. */
export const ReadListParams = z.union([WorkflowListQuery, RunLedgerQuery]);
export type ReadListParams = z.infer<typeof ReadListParams>;

/** How an active run is shown (plan_ui §8 displayed states). */
export const LedgerDisplayedState = z
  .enum([
    'queued',
    'starting',
    'running',
    'waiting_for_you',
    'needs_review',
    'start_outcome_unknown',
    'worker_not_responding',
    'unknown_owner',
  ])
  .describe(
    'queued, starting, running, waiting_for_you, needs_review (settings drift), start_outcome_unknown, worker_not_responding (no heartbeat for 30 s), or unknown_owner (the manifest says running but its owner cannot be verified).',
  );
export type LedgerDisplayedState = z.infer<typeof LedgerDisplayedState>;

/** A run that has not ended, shown above the paged history. */
export const LedgerActiveRun = ListRunItem.extend({ displayedState: LedgerDisplayedState })
  .strict()
  .describe('A run in progress: never paginated, returned on the first page only.');
export type LedgerActiveRun = z.infer<typeof LedgerActiveRun>;

/** `read.list` result for target `runs`. */
export const RunLedgerPage = z
  .object({
    schemaVersion: z.literal(CLI_READ_SCHEMA_VERSION),
    kind: z.literal('list'),
    items: z.array(ListRunItem),
    next_cursor: z.string().nullable().describe('Cursor for the next page; null on the last page.'),
    source: z
      .enum(['index', 'files'])
      .describe('`files` when the history index was unavailable and runs were read from disk.'),
    scan_truncated: z
      .boolean()
      .optional()
      .describe('File fallback only: the scan stopped at its directory cap.'),
    active: z.array(LedgerActiveRun).describe('Runs in progress (first page only).'),
  })
  .strict()
  .describe('One Ledger page.');
export type RunLedgerPage = z.infer<typeof RunLedgerPage>;

/** The internal, versioned Ledger cursor (base64url JSON). */
export const LedgerCursor = z
  .object({
    v: z.literal(1),
    started_at: isoInstant,
    run_id: z.string().min(1).max(256),
    source: z.enum(['index', 'files']),
  })
  .strict()
  .describe('A position in `started_at DESC, run_id DESC` order.');
export type LedgerCursor = z.infer<typeof LedgerCursor>;

/** The most of `report.md` one `read.report` returns. */
export const REPORT_READ_CAP_BYTES = 512 * 1024;

/**
 * `yantra report --json`. The app's `read.report` adds `truncated` and
 * `bytes` only when `report.md` exceeds {@link REPORT_READ_CAP_BYTES}; it then
 * returns the head of the file, cut at a line boundary.
 */
export const ReportResult = z
  .object({
    schemaVersion: z.literal(CLI_READ_SCHEMA_VERSION),
    kind: z.literal('report'),
    markdown: z.string().describe('The run report, verbatim.'),
    truncated: z.literal(true).optional().describe('Only the head of report.md is included.'),
    bytes: z.number().int().nonnegative().optional().describe('The full size of report.md.'),
  })
  .strict()
  .describe('The `yantra report --json` document.');
export type ReportResult = z.infer<typeof ReportResult>;

/** Rows of `toolCalls` or `captures` one `read.audit` page carries. */
export const AUDIT_WINDOW_ROWS = 500;

const nullableNumber = z.number().nullable();

/** The structured audit of one run: `yantra audit --json` without its envelope. */
export const AuditReport = z
  .object({
    runId: z.string().describe('The run id.'),
    workflowName: z.string().describe('The workflow or command name; `<unknown>` when absent.'),
    status: z.string().describe('The manifest status; `unknown` when absent.'),
    startedAt: z.string().describe('ISO start time; empty when absent.'),
    endedAt: z.string().nullable().describe('ISO end time, or null.'),
    durationMs: nullableNumber.describe('Wall-clock duration, or null.'),
    llmCallCount: z.number().int().nonnegative().describe('Model calls (turns) the run made.'),
    secretLookups: z
      .array(
        z
          .object({
            key: z.string().describe('The secret’s key name; never its value.'),
            stepId: z.string(),
            ts: z.string(),
          })
          .strict(),
      )
      .describe('Secret lookups: key names only, never values.'),
    stepCount: z.number().int().nonnegative().describe('Distinct workflow steps started.'),
    scopeMix: z
      .object({
        publicCount: z.number().int().nonnegative(),
        readOnlyDataCount: z.number().int().nonnegative(),
        authenticatedCount: z.number().int().nonnegative(),
      })
      .strict()
      .describe('Step starts by security scope.'),
    trustNarrative: z.string().describe('The two-to-three sentence summary the CLI prints first.'),
    agent: z
      .object({
        adapter: z.string(),
        sdkVersion: z.string(),
        provider: z.string(),
        model: z.string(),
        thinking: z.string(),
        authSource: z.string(),
        sessionId: z.string(),
        sessionFile: z.string().describe('Run-relative path of the provider session log.'),
        promptVersion: z.string(),
      })
      .strict()
      .nullable()
      .describe('Provider provenance of an agentic run, or null.'),
    toolCalls: z
      .array(
        z
          .object({
            seq: z.number().int(),
            callId: z.string(),
            tool: z.string(),
            status: z.enum(['ok', 'error', 'denied', 'aborted', 'incomplete']),
            durationMs: nullableNumber,
            confirmationId: z.string().nullable(),
            confirmationDecision: z.string().nullable(),
            incomplete: z.boolean(),
          })
          .strict(),
      )
      .describe('Agent tool calls in sequence order; in `read.audit`, one window of them.'),
    captures: z
      .array(
        z
          .object({
            path: z.string(),
            sha256: z.string(),
            mimeType: z.literal('image/png'),
            width: nullableNumber,
            height: nullableNumber,
            bytes: z.number().int().nonnegative(),
            sentToModel: z.boolean().describe('Shown to the model provider (Vision Assist).'),
            toolCall: z
              .object({ seq: z.number().int(), callId: z.string(), tool: z.string() })
              .strict(),
            budgetConsumed: z
              .object({
                captures: z.literal(1),
                pixels: z.number().nonnegative(),
                bytes: z.number().int().nonnegative(),
              })
              .strict(),
          })
          .strict(),
      )
      .describe('Every capture the run wrote; in `read.audit`, one window of them.'),
    rawSessionLogCaptureBearing: z
      .boolean()
      .describe('The raw provider session log contains image data a capture sent.'),
    usage: z
      .object({
        turns: z.number().int().nonnegative(),
        inputTokens: nullableNumber,
        outputTokens: nullableNumber,
        costUsd: nullableNumber,
      })
      .strict()
      .nullable()
      .describe('Provider usage, or null.'),
    terminalError: z
      .object({ code: z.string(), message: z.string() })
      .strict()
      .nullable()
      .describe('A typed startup failure, or null.'),
  })
  .strict()
  .describe('The audit story of one run.');
export type AuditReport = z.infer<typeof AuditReport>;

/** `yantra audit --json`: the report inside the CLI envelope. */
export const AuditResult = AuditReport.extend({
  schemaVersion: z.literal(CLI_READ_SCHEMA_VERSION),
  kind: z.literal('audit'),
})
  .strict()
  .describe('The `yantra audit --json` document.');
export type AuditResult = z.infer<typeof AuditResult>;

const AuditCursor = z.string().min(1).max(128).describe('Opaque cursor from a previous page.');

/** `read.audit` params. */
export const AuditParams = z
  .object({
    run_id: RunId,
    tool_calls_cursor: AuditCursor.optional(),
    captures_cursor: AuditCursor.optional(),
  })
  .strict()
  .describe('One page of a run’s audit.');
export type AuditParams = z.infer<typeof AuditParams>;

const AuditWindow = z
  .object({
    total: z.number().int().nonnegative().describe('Rows in the whole run.'),
    next_cursor: z.string().nullable().describe('Cursor for the next window; null at the end.'),
  })
  .strict();

/** `read.audit` result: the report with one window of tool calls and of captures. */
export const AuditPage = z
  .object({
    report: AuditReport,
    tool_calls: AuditWindow,
    captures: AuditWindow,
  })
  .strict()
  .describe('One page of a run’s audit, at most 768 KiB serialized.');
export type AuditPage = z.infer<typeof AuditPage>;
