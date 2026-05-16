/**
 * Pure function library for assembling a `RecordingDraft` from session state.
 *
 * No I/O — the store is responsible for persistence. This module is purely
 * functional and easy to unit-test without touching the filesystem.
 */

import { RecordingDraftSchema } from '@yantra/protocol';
import type {
  CapturedAction,
  RecordingDraft,
  RecordingMetadata,
  StopReason,
} from '@yantra/protocol';

export interface AssembleDraftOptions {
  recordingId: string;
  workflowNameHint: string;
  startedAt: string;
  stoppedAt: string;
  stopReason: StopReason;
  actions: readonly CapturedAction[];
  metadata: RecordingMetadata;
}

/**
 * Assemble and validate a `RecordingDraft` from session state.
 *
 * @param opts - All fields needed to produce a valid draft
 * @returns Validated `RecordingDraft` ready for `RecordingStore.saveDraft`
 * @throws {Error} when the assembled draft fails Zod validation
 *
 * @example
 * const draft = assembleDraft({ recordingId: '...', workflowNameHint: 'bank-stmt', ... });
 */
export function assembleDraft(opts: AssembleDraftOptions): RecordingDraft {
  const draft = {
    schema_version: '0.1' as const,
    recording_id: opts.recordingId,
    workflow_name_hint: opts.workflowNameHint,
    started_at: opts.startedAt,
    stopped_at: opts.stoppedAt,
    stop_reason: opts.stopReason,
    actions: opts.actions as CapturedAction[],
    metadata: {
      ...opts.metadata,
      capture_count: opts.actions.length,
      end_ts: opts.stoppedAt,
      stop_reason: opts.stopReason,
    },
  };

  const result = RecordingDraftSchema.safeParse(draft);
  if (!result.success) {
    throw new Error(
      `assembleDraft: validation failed — ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }

  return result.data;
}

/**
 * Compute per-page dwell times from the ordered action list.
 *
 * Dwell is the time span between the first and last action on each URL.
 * Only `click` and `fill` actions are used as timing anchors; `navigate`
 * and `wait` actions update the current URL.
 *
 * @param actions - Ordered list of captured actions
 * @returns Array of { url, ms } dwell entries in visit order, deduplicated
 */
export function computeDwellPerPage(
  actions: readonly CapturedAction[],
): Array<{ url: string; ms: number }> {
  const result: Array<{ url: string; ms: number }> = [];
  let currentUrl: string | null = null;
  let firstTs: number | null = null;
  let lastTs: number | null = null;

  function flush(): void {
    if (currentUrl !== null && firstTs !== null && lastTs !== null) {
      result.push({ url: currentUrl, ms: Math.max(0, lastTs - firstTs) });
    }
  }

  for (const action of actions) {
    const ts = safeParseTs(action.ts);
    const url = actionUrl(action);

    if (url === null || ts === null) continue;

    if (url !== currentUrl) {
      flush();
      currentUrl = url;
      firstTs = ts;
      lastTs = ts;
    } else {
      lastTs = ts;
    }
  }

  flush();
  return result;
}

function actionUrl(action: CapturedAction): string | null {
  if (action.kind === 'click' || action.kind === 'fill') return action.url_before;
  if (action.kind === 'navigate') return action.url_after;
  if (action.kind === 'wait') return action.url;
  return null;
}

function safeParseTs(ts: string): number | null {
  const n = new Date(ts).getTime();
  return isNaN(n) ? null : n;
}
