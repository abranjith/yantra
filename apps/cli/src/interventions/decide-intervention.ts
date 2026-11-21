/**
 * One answer path for a consent request, shared by `yantra confirm` and the
 * app host (plan D12, review REV-001).
 *
 * The worker that owns a live run is the only decision authority. A parked
 * claim is written only when the run has no owner (no lease, or the owner is
 * dead). When an owner might be alive but cannot be reached, nothing is
 * written and the caller reports that, so one request is never decided twice.
 */

import {
  INTERVENTIONS_CAPABILITY,
  NodeProcessLivenessProbe,
  ParkedDecisionService,
  RunChannelClient,
  ownerVerdict,
  readLease,
} from '@yantra/core';
import { DecisionResponse as DecisionResponseSchema } from '@yantra/protocol';
import type { DecisionResponse } from '@yantra/protocol';

export type DecidedBy = 'user_cli_confirm' | 'user_app';

/**
 * What a live attempt produced: the owner's response, `null` when the run has
 * no live owner, or why a possibly-live owner could not be asked.
 */
export type LiveAttempt = DecisionResponse | 'unavailable' | 'unreachable' | null;

export interface LiveDecisionOptions {
  /** How long to wait for the owner's `intervention.response`. */
  readonly replyTimeoutMs?: number;
}

/** Asks the run's live owner over its run socket, when it has one. */
export async function tryLiveDecision(
  runDir: string,
  confirmationId: string,
  decision: 'granted' | 'denied',
  decidedBy: DecidedBy,
  options: LiveDecisionOptions = {},
): Promise<LiveAttempt> {
  const lease = await readLease(runDir).catch(() => ({ kind: 'absent' as const }));
  if (lease.kind !== 'lease') return null;
  const verdict = await ownerVerdict(lease.lease, new NodeProcessLivenessProbe());
  if (verdict === 'dead') return null;
  if (verdict === 'unknown') return 'unavailable';
  const client = new RunChannelClient({
    // The owner records provenance from the client kind (REV-010): the app
    // host answers for a window, `yantra confirm` answers as the CLI.
    clientKind: decidedBy === 'user_app' ? 'host' : 'cli',
    runDir,
    capabilities: [INTERVENTIONS_CAPABILITY],
    helloTimeoutMs: 750,
    notRespondingMs: 1_500,
  });
  let resolveResponse!: (value: DecisionResponse) => void;
  const waiting = new Promise<DecisionResponse>((resolve) => {
    resolveResponse = resolve;
  });
  const dispose = client.onServerMessage((message) => {
    if (message.type !== 'intervention.response') return;
    const parsed = DecisionResponseSchema.safeParse(message.response);
    if (message.intervention_id !== confirmationId || !parsed.success) return;
    resolveResponse(parsed.data);
  });
  let timer: NodeJS.Timeout | undefined;
  try {
    const connected = await client.connect(lease.lease);
    if (connected.state === 'live_unavailable') return 'unavailable';
    if (connected.state !== 'attached') return 'unreachable';
    // An owner that does not serve interventions cannot decide; never wait on it.
    if (!connected.capabilities.includes(INTERVENTIONS_CAPABILITY)) return 'unavailable';
    client.send({
      type: 'intervention.answer',
      intervention_id: confirmationId,
      decision,
      decided_by: decidedBy,
    });
    return await Promise.race([
      waiting,
      new Promise<'unreachable'>((resolve) => {
        timer = setTimeout(() => resolve('unreachable'), options.replyTimeoutMs ?? 1_500);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    dispose();
    client.close();
  }
}

export interface DecideInterventionInput {
  readonly runDir: string;
  readonly runId: string;
  readonly confirmationId: string;
  readonly decision: 'granted' | 'denied';
  readonly decidedBy: DecidedBy;
  readonly live?: LiveDecisionOptions;
}

export type DecideInterventionOutcome =
  | {
      readonly kind: 'decided';
      readonly case: 'live' | 'parked';
      readonly response: DecisionResponse;
    }
  | { readonly kind: 'owner_unreachable'; readonly reason: 'unavailable' | 'unreachable' };

/** Live owner first; a parked claim only when the run has no live owner. */
export async function decideIntervention(
  input: DecideInterventionInput,
  attempt: typeof tryLiveDecision = tryLiveDecision,
): Promise<DecideInterventionOutcome> {
  const live = await attempt(
    input.runDir,
    input.confirmationId,
    input.decision,
    input.decidedBy,
    input.live,
  );
  if (live === 'unavailable' || live === 'unreachable') {
    return { kind: 'owner_unreachable', reason: live };
  }
  if (live !== null) return { kind: 'decided', case: 'live', response: live };
  const response = await new ParkedDecisionService().decideParked({
    runDir: input.runDir,
    runId: input.runId,
    decision: input.decision,
    decidedBy: input.decidedBy,
    confirmationId: input.confirmationId,
  });
  return { kind: 'decided', case: 'parked', response };
}
