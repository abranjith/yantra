import { z } from 'zod';

import { Brief } from './brief.js';
import { LedgerMode } from './cli-reads.js';
import { TemplatedReport } from './report-template.js';
import { RunArtifactExposure, RunArtifactViewer, RunId } from './run-artifacts.js';
import { RunHealth } from './run-health.js';
import { ExecutionState } from './run-lease.js';
import { TaskOutcome, TerminationReason } from './task-outcome.js';

/**
 * The run-result view (FEAT-066 TASK-004): everything the app's Run result
 * page needs, read from one run directory. Every artifact is an independent
 * {@link ArtifactSlot}, so one missing, corrupt, legacy or oversized file
 * fails only its own slot, never the page.
 */

/** The largest serialized `RunResultView` (plan §7: under the 1 MiB message limit). */
export const RUN_RESULT_MAX_BYTES = 768 * 1024;
/** The most inventory items one view lists. */
export const RUN_INVENTORY_MAX_ITEMS = 2_000;
/** The longest terminal-reason text field, after ANSI stripping. */
export const TERMINAL_TEXT_MAX = 500;
/** The longest corrupt-slot detail. */
export const SLOT_DETAIL_MAX = 200;

const RelPath = z.string().min(1).max(512).describe('Run-relative path, forward slashes.');

/** One artifact read: its value, or exactly why it is not shown. */
export function artifactSlot<T extends z.ZodTypeAny>(value: T) {
  return z
    .discriminatedUnion('state', [
      z.object({ state: z.literal('ok'), value, path: RelPath }).strict(),
      z.object({ state: z.literal('missing'), path: RelPath }).strict(),
      z
        .object({
          state: z.literal('corrupt'),
          path: RelPath,
          detail: z
            .string()
            .max(SLOT_DETAIL_MAX)
            .describe('A bounded parse or validation summary; never file content.'),
        })
        .strict(),
      z
        .object({
          state: z.literal('unsupported'),
          path: RelPath,
          found_version: z
            .string()
            .max(64)
            .describe('The schema_version the file declares, e.g. `0.1`.'),
        })
        .strict(),
      z
        .object({
          state: z.literal('too_large'),
          path: RelPath,
          bytes: z.number().int().nonnegative(),
          cap: z.number().int().positive(),
        })
        .strict(),
      z.object({ state: z.literal('denied'), path: RelPath }).strict(),
    ])
    .describe(
      'One artifact: ok with its value, or missing, corrupt, unsupported, too large or denied.',
    );
}

/** The state names of an {@link artifactSlot}. */
export const ArtifactSlotState = z.enum([
  'ok',
  'missing',
  'corrupt',
  'unsupported',
  'too_large',
  'denied',
]);
export type ArtifactSlotState = z.infer<typeof ArtifactSlotState>;

/** A slot of any value type, as TypeScript sees it. */
export type ArtifactSlot<T> =
  | { state: 'ok'; value: T; path: string }
  | { state: 'missing'; path: string }
  | { state: 'corrupt'; path: string; detail: string }
  | { state: 'unsupported'; path: string; found_version: string }
  | { state: 'too_large'; path: string; bytes: number; cap: number }
  | { state: 'denied'; path: string };

const boundedText = z.string().max(TERMINAL_TEXT_MAX);

/** Why a run ended, read from the first source that recorded it. */
export const TerminalReason = z
  .object({
    source: z
      .enum(['run_outcome', 'manifest', 'events', 'report'])
      .describe(
        'Which reader answered: the run-event stream, manifest, events.jsonl or report.md.',
      ),
    failure_class: boundedText.optional().describe('The failure category, verbatim.'),
    message: boundedText.optional().describe('What happened, ANSI-stripped and bounded.'),
    blocker: boundedText.optional().describe('What blocked the run, for a handoff.'),
    safest_next_action: boundedText.optional().describe('The one next step the run recorded.'),
    termination_reason: TerminationReason.optional(),
  })
  .strict()
  .describe('Why the run ended; every text bounded to 500 characters.');
export type TerminalReason = z.infer<typeof TerminalReason>;

/** One public file in the run directory (denied files are never listed). */
export const ArtifactInventoryItem = z
  .object({
    path: RelPath,
    entry_id: z.string().min(1).describe('The RUN_ARTIFACT_REGISTRY entry it matched.'),
    exposure: RunArtifactExposure,
    viewer: RunArtifactViewer,
    bytes: z.number().int().nonnegative(),
    modified_at: z.string().datetime({ offset: true }),
    over_inline_cap: z.boolean().describe('Larger than its viewer loads whole.'),
  })
  .strict()
  .describe('One public run file.');
export type ArtifactInventoryItem = z.infer<typeof ArtifactInventoryItem>;

/** `read.run_result {run_id}` params. */
export const RunResultParams = z.object({ run_id: RunId }).strict();
export type RunResultParams = z.infer<typeof RunResultParams>;

export const BriefSlot = artifactSlot(Brief);
export const TemplatedReportSlot = artifactSlot(TemplatedReport);
export const OutputsSlot = artifactSlot(z.record(z.unknown()));
export const RunHealthSlot = artifactSlot(RunHealth);

/** `read.run_result` result. */
export const RunResultView = z
  .object({
    run_id: RunId,
    mode: z.union([LedgerMode, z.literal('unknown')]),
    title: z.string().describe('Document title, else the intent or query, else the workflow name.'),
    started_at: z.string().nullable(),
    ended_at: z.string().nullable(),
    duration_ms: z.number().int().nonnegative().nullable(),
    status: z.string().describe('The manifest status as the CLI prints it.'),
    task_outcome: TaskOutcome.nullable(),
    termination_reason: TerminationReason.nullable(),
    execution_state: ExecutionState.nullable(),
    live: z
      .object({ state: z.enum(['running', 'waiting_for_you', 'unknown_owner']) })
      .strict()
      .nullable()
      .describe(
        'Present only while the run has not ended; unknown_owner when its owner cannot be verified.',
      ),
    document: z
      .discriminatedUnion('kind', [
        z.object({ kind: z.literal('brief'), slot: BriefSlot }).strict(),
        z.object({ kind: z.literal('templated_report'), slot: TemplatedReportSlot }).strict(),
        z.object({ kind: z.literal('none') }).strict(),
      ])
      .describe('The Brief or templated document, or none.'),
    outputs: OutputsSlot.nullable().describe('A workflow run’s outputs.json; null for other runs.'),
    terminal: TerminalReason.nullable(),
    run_health: RunHealthSlot,
    report: z
      .object({ exists: z.boolean(), bytes: z.number().int().nonnegative().nullable() })
      .strict()
      .describe('report.md; its body is read lazily through read.report.'),
    artifacts: z.array(ArtifactInventoryItem).max(RUN_INVENTORY_MAX_ITEMS),
    artifacts_truncated: z.boolean(),
    notices_source: z
      .enum(['brief', 'document', 'run_health', 'none'])
      .describe('Where the Notices block comes from.'),
  })
  .strict()
  .describe('One run, read for the app’s Run result page.');
export type RunResultView = z.infer<typeof RunResultView>;

/** The longest line text one window returns; longer lines are cut and say so. */
export const JSONL_LINE_MAX_BYTES = 16 * 1024;
/** The largest serialized JSONL window. */
export const JSONL_WINDOW_MAX_BYTES = 512 * 1024;
/** The most lines one window asks for. */
export const JSONL_WINDOW_MAX_LINES = 200;

/** `read.artifact_window` params: one window of a public JSONL file. */
export const JsonlWindowRequest = z
  .object({
    run_id: RunId,
    path: RelPath,
    from_line: z.number().int().nonnegative().describe('0-based first line wanted.'),
    limit: z.number().int().min(1).max(JSONL_WINDOW_MAX_LINES).describe('Lines wanted, 1–200.'),
  })
  .strict()
  .describe('One window of a JSONL artifact.');
export type JsonlWindowRequest = z.infer<typeof JsonlWindowRequest>;

/** `read.artifact_window` result. */
export const JsonlWindow = z
  .object({
    path: RelPath,
    total_lines_known: z
      .number()
      .int()
      .nonnegative()
      .describe('Complete lines counted so far; final once total_complete is true.'),
    total_complete: z.boolean().describe('The index has reached the end of the file.'),
    from_line: z.number().int().nonnegative(),
    lines: z
      .array(
        z
          .object({
            n: z.number().int().nonnegative().describe('0-based line number.'),
            text: z.string().describe('The line, cut at 16 KiB.'),
            truncated_bytes: z
              .number()
              .int()
              .nonnegative()
              .describe('Bytes of the line not included; 0 when whole.'),
          })
          .strict(),
      )
      .max(JSONL_WINDOW_MAX_LINES),
    partial_tail: z
      .boolean()
      .describe('The file ends in a line still being written; it is never returned.'),
  })
  .strict()
  .describe('One window of a JSONL artifact, at most 512 KiB serialized.');
export type JsonlWindow = z.infer<typeof JsonlWindow>;
