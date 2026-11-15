import { buildNotification, type Notifier } from '../scheduler/notify.js';

import type { InterventionAuthority } from './authority.js';

export interface NeedsYouNotifierSink {
  notifyWithAttempts(
    notification: Parameters<Notifier['notify']>[0],
    target: Parameters<Notifier['notify']>[1],
    context: { readonly interventionId: string; readonly runId: string },
  ): Promise<void>;
}

/** Best-effort desktop notification policy for unattended live consent. */
export interface NeedsYouNotifierOptions {
  readonly authority: InterventionAuthority;
  readonly notifier: NeedsYouNotifierSink;
  readonly runId: string;
  readonly subject: string;
  readonly now?: () => Date;
}

export class NeedsYouNotifier {
  private readonly pending = new Set<string>();
  private readonly sentAtRaise = new Set<string>();
  private readonly sentAtDrop = new Set<string>();
  private readonly now: () => Date;
  private readonly dispose: (() => void)[];

  public constructor(private readonly options: NeedsYouNotifierOptions) {
    this.now = options.now ?? (() => new Date());
    this.dispose = [
      options.authority.onRaised((intervention) => {
        this.pending.add(intervention.intervention_id);
        if (options.authority.attendance() === 0) {
          this.sentAtRaise.add(intervention.intervention_id);
          void this.notify(intervention.intervention_id);
        }
      }),
      options.authority.onAttendance((count) => {
        if (count !== 0) return;
        for (const interventionId of this.pending) {
          if (this.sentAtRaise.has(interventionId) || this.sentAtDrop.has(interventionId)) continue;
          this.sentAtDrop.add(interventionId);
          void this.notify(interventionId);
        }
      }),
      options.authority.onResolved((interventionId) => {
        this.pending.delete(interventionId);
      }),
    ];
  }

  public close(): void {
    for (const dispose of this.dispose) dispose();
    this.dispose.length = 0;
  }

  private async notify(interventionId: string): Promise<void> {
    try {
      const notification = buildNotification(
        {
          scheduleId: null,
          runId: this.options.runId,
          subject: this.options.subject,
          kind: 'confirmation_needed',
          confirmCommand: `yantra confirm ${this.options.runId} grant`,
        },
        this.now(),
      );
      await this.options.notifier.notifyWithAttempts(notification, 'desktop', {
        interventionId,
        runId: this.options.runId,
      });
    } catch {
      // Delivery is explicitly best effort and never gates the authority.
    }
  }
}
