import type { ConfirmationRequest } from '@yantra/protocol';
import { describe, expect, it } from 'vitest';

import { isParked } from '../../src/executor/confirmation-gateway.js';
import type { NotifyTarget } from '../../src/index-db/schedule-store.js';
import { DaemonConfirmationGateway } from '../../src/scheduler/daemon-confirmation-gateway.js';
import type { Notification, Notifier } from '../../src/scheduler/notify.js';

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

function recordingNotifier(): {
  notifier: Notifier;
  sent: Notification[];
  targets: NotifyTarget[];
} {
  const sent: Notification[] = [];
  const targets: NotifyTarget[] = [];
  return {
    sent,
    targets,
    notifier: {
      notify: (n, t): Promise<void> => {
        sent.push(n);
        targets.push(t);
        return Promise.resolve();
      },
    },
  };
}

function makeRequest(): ConfirmationRequest {
  return {
    confirmation_id: 'C1',
    run_id: 'run-abc',
    step_id: 's2',
    action_kind: 'click',
    host: 'shop.example',
    description: 'Buy the thing',
    expected_cost: { amount: 42, currency: 'USD' },
    consequence: 'irreversible',
    requested_at: '2026-07-05T00:05:00.000Z',
    timeout_ms: null,
  };
}

describe('@no-llm DaemonConfirmationGateway', () => {
  it('ALWAYS parks — it can never return a granted/denied decision', async () => {
    const { notifier } = recordingNotifier();
    const gateway = new DaemonConfirmationGateway({
      scheduleId: 'S1',
      workflowName: 'checkout',
      notifyTarget: 'desktop',
      notifier,
      logger: silentLogger,
    });

    const outcome = await gateway.request(makeRequest());
    expect(isParked(outcome)).toBe(true);
    expect(gateway.parked).toBe(true);
  });

  it('emits a confirmation_needed notification carrying the exact confirm command', async () => {
    const { notifier, sent, targets } = recordingNotifier();
    const gateway = new DaemonConfirmationGateway({
      scheduleId: 'S1',
      workflowName: 'checkout',
      notifyTarget: 'file',
      notifier,
      logger: silentLogger,
    });

    await gateway.request(makeRequest());
    expect(sent).toHaveLength(1);
    expect(sent[0]?.kind).toBe('confirmation_needed');
    expect(sent[0]?.body).toContain('yantra confirm run-abc grant');
    expect(targets[0]).toBe('file');
  });

  it('never leaks the action host/cost/params into the notification body', async () => {
    const { notifier, sent } = recordingNotifier();
    const gateway = new DaemonConfirmationGateway({
      scheduleId: 'S1',
      workflowName: 'checkout',
      notifyTarget: 'file',
      notifier,
      logger: silentLogger,
    });
    await gateway.request(makeRequest());
    // The body is templated over workflow name + the confirm command only.
    expect(sent[0]?.body).not.toContain('shop.example');
    expect(sent[0]?.body).not.toContain('Buy the thing');
  });

  it('parks even when the notifier throws (safety outcome is unconditional)', async () => {
    const throwingNotifier: Notifier = {
      notify: () => Promise.reject(new Error('sink down')),
    };
    const gateway = new DaemonConfirmationGateway({
      scheduleId: 'S1',
      workflowName: 'checkout',
      notifyTarget: 'desktop',
      notifier: throwingNotifier,
      logger: silentLogger,
    });
    const outcome = await gateway.request(makeRequest());
    expect(isParked(outcome)).toBe(true);
  });
});
