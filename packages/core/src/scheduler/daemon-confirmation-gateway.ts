/**
 * Daemon confirmation gateway (FEAT-021 TASK-004) — the unattended half of the
 * "same protocol, two connectors" design (plan §7).
 *
 * Where the CLI's `InteractiveConfirmationGateway` renders a consent card and
 * blocks on a terminal prompt, this gateway **never prompts and never grants**.
 * When the executor asks it to confirm a flagged step, it:
 *   1. emits a `confirmation_needed` notification (with the exact
 *      `yantra confirm <run-id> grant` command in the body), and
 *   2. returns a `parked` signal.
 *
 * The executor then leaves the request pending in `confirmations.jsonl` and
 * checkpoints before the flagged step (resumable). This is the type-level
 * embodiment of plan §6: an unattended run has **no code path** to a `granted`
 * decision — the only outcome it can produce is `parked`.
 *
 * @see .spec-lite/features/feature_scheduling_runner.md TASK-004
 */

import type { ConfirmationRequest } from '@yantra/protocol';

import type { Logger } from '../browser/types.js';
import type { ConfirmationGateway, ConfirmationOutcome } from '../executor/confirmation-gateway.js';
import type { NotifyTarget } from '../index-db/schedule-store.js';

import { buildNotification, type Notifier } from './notify.js';

/** Constructor dependencies for {@link DaemonConfirmationGateway}. */
export interface DaemonConfirmationGatewayDeps {
  /** The schedule id whose fire this gateway serves. */
  readonly scheduleId: string;
  /** The workflow name (for the secret-free notification body). */
  readonly workflowName: string;
  /** Where to deliver the `confirmation_needed` notification. */
  readonly notifyTarget: NotifyTarget;
  /** The notification sink. */
  readonly notifier: Notifier;
  readonly logger?: Logger;
  /** Injectable clock for deterministic notification timestamps. */
  readonly clock?: { now(): Date };
}

/**
 * A {@link ConfirmationGateway} that parks-and-notifies. Records whether it was
 * ever asked to confirm (so the fire-runner can map the outcome to
 * `pending-confirmation`).
 */
export class DaemonConfirmationGateway implements ConfirmationGateway {
  private readonly deps: DaemonConfirmationGatewayDeps;
  /** True once a flagged step has parked this run. */
  public parked = false;

  public constructor(deps: DaemonConfirmationGatewayDeps) {
    this.deps = deps;
  }

  public async request(request: ConfirmationRequest): Promise<ConfirmationOutcome> {
    this.parked = true;

    const notification = buildNotification(
      {
        scheduleId: this.deps.scheduleId,
        runId: request.run_id,
        workflowName: this.deps.workflowName,
        kind: 'confirmation_needed',
        confirmCommand: `yantra confirm ${request.run_id} grant`,
      },
      this.deps.clock?.now(),
    );

    try {
      await this.deps.notifier.notify(notification, this.deps.notifyTarget);
    } catch (error) {
      // Notification failure must not change the safety outcome — we still park.
      this.deps.logger?.warn?.(
        {
          runId: request.run_id,
          error: error instanceof Error ? error.message : String(error),
        },
        'confirmation notification failed; parking anyway',
      );
    }

    this.deps.logger?.info?.(
      { runId: request.run_id, stepId: request.step_id },
      'scheduled run parked for confirmation (never auto-confirmed)',
    );

    // The ONLY outcome this gateway can produce.
    return { kind: 'parked' };
  }
}
