import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ok, type Result } from '@yantra/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HistoryStore } from '../../src/index-db/history-store.js';
import type { NotifyTarget, Schedule } from '../../src/index-db/schedule-store.js';
import type { IndexDbError } from '../../src/index-db/types.js';
import type {
  FireRunDriver,
  FireRunOutcome,
  FireRunnerDeps,
} from '../../src/scheduler/fire-runner.js';
import { runScheduledFire } from '../../src/scheduler/fire-runner.js';
import type { Notification, Notifier } from '../../src/scheduler/notify.js';
import type { ScheduleLink } from '../../src/scheduler/schedule-link.js';

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

function makeSchedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: 'SCH1',
    workflowName: 'demo',
    cronExpr: '*/5 * * * *',
    params: {},
    notifyTarget: 'file',
    onConfirm: 'pause-and-notify',
    enabled: true,
    createdAt: '2026-07-05T00:00:00.000Z',
    lastFireAt: null,
    nextFireAt: null,
    lastRunId: null,
    lastStatus: null,
    ...overrides,
  };
}

/** Records every notification the runner emits. */
function recordingNotifier(): { notifier: Notifier; sent: Notification[] } {
  const sent: Notification[] = [];
  return {
    sent,
    notifier: {
      notify: (n: Notification, _t: NotifyTarget): Promise<void> => {
        sent.push(n);
        return Promise.resolve();
      },
    },
  };
}

/** A driver that returns a fixed outcome and, optionally, invokes the gateway. */
function driverFor(outcome: FireRunOutcome, opts: { invokeGateway?: boolean } = {}): FireRunDriver {
  return {
    async run(request): Promise<FireRunOutcome> {
      if (opts.invokeGateway === true) {
        // Simulate a flagged step: the executor would call the gateway here.
        await request.confirmationGateway.request({
          confirmation_id: 'C1',
          run_id: outcome.runId,
          step_id: 's2',
          action_kind: 'click',
          host: 'shop.example',
          description: 'Buy now',
          expected_cost: null,
          consequence: 'irreversible',
          requested_at: '2026-07-05T00:05:00.000Z',
          timeout_ms: null,
        });
      }
      return outcome;
    },
  };
}

const noHistory: HistoryStore = {
  record: () => Promise.resolve(ok(undefined)) as Promise<Result<void, IndexDbError>>,
  recordFromRunDir: () => Promise.resolve(ok(true)) as Promise<Result<boolean, IndexDbError>>,
  list: () => Promise.resolve(ok([])) as ReturnType<HistoryStore['list']>,
  usageRollup: () => Promise.resolve(ok([])) as ReturnType<HistoryStore['usageRollup']>,
  rebuildFromRuns: () =>
    Promise.resolve(ok({ rowCount: 0 })) as ReturnType<HistoryStore['rebuildFromRuns']>,
};

describe('@no-llm runScheduledFire', () => {
  it('reports succeeded, records history, and notifies completed on a success', async () => {
    const { notifier, sent } = recordingNotifier();
    const recordSpy = vi.fn(
      () => Promise.resolve(ok(true)) as Promise<Result<boolean, IndexDbError>>,
    );
    const history: HistoryStore = { ...noHistory, recordFromRunDir: recordSpy };

    const deps: FireRunnerDeps = {
      driver: driverFor({ kind: 'success', runId: 'run-1' }),
      history,
      notifier,
      logger: silentLogger,
    };
    const result = await runScheduledFire(
      makeSchedule(),
      new Date('2026-07-05T00:05:00.000Z'),
      deps,
    );

    expect(result).toEqual({ runId: 'run-1', status: 'succeeded' });
    expect(recordSpy).toHaveBeenCalledWith('run-1');
    expect(sent.map((n) => n.kind)).toEqual(['completed']);
  });

  it('reports failed and notifies failed on a failure outcome', async () => {
    const { notifier, sent } = recordingNotifier();
    const deps: FireRunnerDeps = {
      driver: driverFor({ kind: 'failure', runId: 'run-2' }),
      history: noHistory,
      notifier,
      logger: silentLogger,
    };
    const result = await runScheduledFire(makeSchedule(), new Date(), deps);

    expect(result).toEqual({ runId: 'run-2', status: 'failed' });
    expect(sent.map((n) => n.kind)).toEqual(['failed']);
  });

  it('reports pending-confirmation when the gateway parked (never a completed notification)', async () => {
    const { notifier, sent } = recordingNotifier();
    const deps: FireRunnerDeps = {
      driver: driverFor(
        { kind: 'aborted', runId: 'run-3', reason: 'user-handoff' },
        {
          invokeGateway: true,
        },
      ),
      history: noHistory,
      notifier,
      logger: silentLogger,
    };
    const result = await runScheduledFire(makeSchedule(), new Date(), deps);

    expect(result).toEqual({ runId: 'run-3', status: 'pending-confirmation' });
    // The gateway emitted confirmation_needed; the runner must NOT add completed.
    expect(sent.map((n) => n.kind)).toEqual(['confirmation_needed']);
  });

  it('maps a non-park user-handoff abort to handoff', async () => {
    const { notifier } = recordingNotifier();
    const deps: FireRunnerDeps = {
      driver: driverFor({ kind: 'aborted', runId: 'run-4', reason: 'user-handoff' }),
      history: noHistory,
      notifier,
      logger: silentLogger,
    };
    const result = await runScheduledFire(makeSchedule(), new Date(), deps);
    expect(result.status).toBe('handoff');
  });

  it('reports failed when the driver throws, with a null run id and a failed notice', async () => {
    const { notifier, sent } = recordingNotifier();
    const throwingDriver: FireRunDriver = {
      run: () => Promise.reject(new Error('browser launch failed')),
    };
    const deps: FireRunnerDeps = {
      driver: throwingDriver,
      history: noHistory,
      notifier,
      logger: silentLogger,
    };
    const result = await runScheduledFire(makeSchedule(), new Date(), deps);

    expect(result).toEqual({ runId: null, status: 'failed' });
    expect(sent.map((n) => n.kind)).toEqual(['failed']);
  });

  it('never records completed/failed via a spy on the schedule params (no param leakage into bodies)', async () => {
    const { notifier, sent } = recordingNotifier();
    const schedule = makeSchedule({ params: { token: 'sk-supersecret-value-1234567890' } });
    const deps: FireRunnerDeps = {
      driver: driverFor({ kind: 'success', runId: 'run-5' }),
      history: noHistory,
      notifier,
      logger: silentLogger,
    };
    await runScheduledFire(schedule, new Date(), deps);
    // Body is templated over workflow name + status only — never params.
    for (const n of sent) {
      expect(n.body).not.toContain('sk-supersecret');
      expect(JSON.stringify(n)).not.toContain('sk-supersecret');
    }
  });
});

describe('@no-llm runScheduledFire schedule-link sidecar', () => {
  let runsDir: string;

  beforeEach(async () => {
    runsDir = await mkdtemp(join(tmpdir(), 'yantra-fire-runs-'));
  });

  afterEach(async () => {
    await rm(runsDir, { recursive: true, force: true });
  });

  it('writes a secret-free schedule.json sidecar into the run dir for audit narration', async () => {
    const { notifier } = recordingNotifier();
    const runId = 'run-sidecar';
    await mkdir(join(runsDir, runId), { recursive: true });

    const schedule = makeSchedule({
      id: 'SCH1',
      params: { token: 'sk-supersecret-value-1234567890' },
    });
    const firedAt = new Date('2026-07-05T08:00:00.000Z');
    await runScheduledFire(schedule, firedAt, {
      driver: driverFor({ kind: 'success', runId }),
      history: noHistory,
      notifier,
      logger: silentLogger,
      runsDir,
    });

    const raw = await readFile(join(runsDir, runId, 'schedule.json'), 'utf8');
    const link = JSON.parse(raw) as ScheduleLink;
    expect(link).toMatchObject({
      schedule_id: 'SCH1',
      workflow_name: 'demo',
      cron_expr: '*/5 * * * *',
      fired_at: '2026-07-05T08:00:00.000Z',
      status: 'succeeded',
    });
    // The sidecar never carries params/secrets.
    expect(raw).not.toContain('sk-supersecret');
    expect(raw).not.toContain('token');
  });

  it('records pending-confirmation in the sidecar when the fire parked', async () => {
    const { notifier } = recordingNotifier();
    const runId = 'run-parked-sidecar';
    await mkdir(join(runsDir, runId), { recursive: true });

    await runScheduledFire(makeSchedule({ id: 'SCH2' }), new Date(), {
      driver: driverFor(
        { kind: 'aborted', runId, reason: 'user-handoff' },
        { invokeGateway: true },
      ),
      history: noHistory,
      notifier,
      logger: silentLogger,
      runsDir,
    });

    const raw = await readFile(join(runsDir, runId, 'schedule.json'), 'utf8');
    const link = JSON.parse(raw) as ScheduleLink;
    expect(link.status).toBe('pending-confirmation');
  });
});
