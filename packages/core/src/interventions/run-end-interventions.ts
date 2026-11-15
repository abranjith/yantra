import { basename, join } from 'node:path';

import { generateUlid } from '@yantra/protocol';

import { InterventionLog } from './intervention-log.js';

export interface RunEndHandoff {
  readonly blocker: string;
  readonly safestNextAction: string;
}

export interface RunEndBrief {
  readonly unmet?: readonly { readonly label: string; readonly reason: string }[];
}

export interface RecordRunEndInterventionsOptions {
  readonly runDir: string;
  readonly runId?: string;
  readonly log?: InterventionLog;
  readonly outcome: string | { readonly kind?: string };
  readonly handoff?: RunEndHandoff | null;
  readonly brief?: RunEndBrief | null;
  readonly resumable?: boolean;
  readonly takeover?: RunEndHandoff | null;
  readonly now?: () => string;
}

/** Records non-consent items raised by a completed run, without duplicating consent handoffs. */
export async function recordRunEndInterventions(
  options: RecordRunEndInterventionsOptions,
): Promise<void> {
  const now = options.now ?? (() => new Date().toISOString());
  const runId = options.runId ?? basename(options.runDir);
  const log = options.log ?? new InterventionLog(join(options.runDir, 'interventions.jsonl'));
  const outcome =
    typeof options.outcome === 'string' ? options.outcome : (options.outcome.kind ?? '');
  const existing = await log.readAll();
  const consentDenied = existing.some(
    (entry) =>
      entry.entry === 'resolved' &&
      (entry.decision.decision === 'denied' || entry.decision.decision === 'timed_out'),
  );

  if (outcome === 'handoff' && options.handoff !== null && options.handoff !== undefined) {
    if (!consentDenied) {
      await log.append({
        entry: 'raised',
        intervention: {
          intervention_id: generateUlid(),
          run_id: runId,
          kind: 'handoff',
          state: 'recorded',
          raised_at: now(),
          handoff: {
            blocker: options.handoff.blocker,
            safest_next_action: options.handoff.safestNextAction,
          },
          missing: null,
          recovery: options.resumable === true ? 'resume' : 'run_again',
        },
      });
    }
  }

  const unmet = options.brief?.unmet ?? [];
  if (outcome === 'partial' && unmet.length > 0) {
    await log.append({
      entry: 'raised',
      intervention: {
        intervention_id: generateUlid(),
        run_id: runId,
        kind: 'input',
        state: 'recorded',
        raised_at: now(),
        handoff: null,
        missing: unmet.slice(0, 20).map((item) => ({ label: item.label, reason: item.reason })),
        recovery: options.resumable === true ? 'resume' : 'run_again',
      },
    });
  }

  if (options.takeover !== null && options.takeover !== undefined) {
    await log.append({
      entry: 'raised',
      intervention: {
        intervention_id: generateUlid(),
        run_id: runId,
        kind: 'takeover',
        state: 'recorded',
        raised_at: now(),
        handoff: {
          blocker: options.takeover.blocker,
          safest_next_action: options.takeover.safestNextAction,
        },
        missing: null,
        recovery: 'run_again',
      },
    });
  }
}
