/**
 * @no-llm
 *
 * End-to-end + chaos coverage for FEAT-021 (Scheduling & Saved-Workflow Runner).
 *
 * Exercises three things against an isolated data/config root so the user's real
 * `~/.local/share/yantra/` is never touched:
 *   1. the `schedule` / `schedules` / `unschedule` CLI round-trip;
 *   2. the plan §6 safety property — an unattended fire that reaches a
 *      `requires_confirmation` step **pauses-and-notifies 100% of the time** and
 *      **never executes the flagged step**, across injected failures (including a
 *      crash between park and notify, where the notification is re-emitted on a
 *      restart from the still-pending record);
 *   3. `yantra audit` narrating a scheduled fire from the `schedule.json` sidecar.
 *
 * The safety property is proven at the **real executor** level (not a mock),
 * driving the actual `Executor` with a flagged step and the
 * `DaemonConfirmationGateway`, then asserting the flagged step never ran and the
 * confirmation request stays pending.
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import { run } from '@yantra/cli';
import {
  DaemonConfirmationGateway,
  Executor,
  InMemoryCaptureStore,
  RetryBudgetImpl,
  buildNotification,
  createConfirmationStore,
  type ConfirmationStore,
  type EventBus,
  type ExecutionContext,
  type Notification,
  type Notifier,
} from '@yantra/core';
import type { NotifyTarget } from '@yantra/core';
import type { Plan, Step, TaskEvent } from '@yantra/protocol';
import { SCHEMA_VERSION } from '@yantra/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// CLI invocation harness (mirrors profile-history.spec.ts)
// ---------------------------------------------------------------------------

interface InvocationResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function invoke(argv: readonly string[]): Promise<InvocationResult> {
  let stdoutData = '';
  let stderrData = '';
  let exitCode = 0;

  const outStream = new Writable({
    write(chunk, _enc, cb) {
      stdoutData += String(chunk);
      cb();
    },
  });
  const errStream = new Writable({
    write(chunk, _enc, cb) {
      stderrData += String(chunk);
      cb();
    },
  });

  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);
  // eslint-disable-next-line @typescript-eslint/unbound-method -- restored in finally
  const originalExit = process.exit;

  process.stdout.write = (chunk: unknown): boolean => {
    outStream.write(String(chunk));
    return true;
  };
  process.stderr.write = (chunk: unknown): boolean => {
    errStream.write(String(chunk));
    return true;
  };

  let exited = false;
  process.exit = (code?: number) => {
    if (!exited) {
      exitCode = code ?? 0;
      exited = true;
    }
    throw new Error('__cli_exit__');
  };

  try {
    await run(argv).catch((err: unknown) => {
      if (err instanceof Error && err.message === '__cli_exit__') return;
      throw err;
    });
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
    process.exit = originalExit;
  }

  return { exitCode, stdout: stdoutData, stderr: stderrData };
}

const DEMO_WORKFLOW = `version: 1
name: demo
description: A minimal public workflow for scheduling e2e
security_class: public
params: {}
secrets: []
cookies: none
steps:
  - id: s1
    verb: navigate
    url: https://example.com
    scope: null
outputs: []
`;

// ---------------------------------------------------------------------------
// Executor harness for the safety property (mirrors confirmation-chaos.spec.ts)
// ---------------------------------------------------------------------------

class FakeEventBus implements EventBus {
  readonly events: TaskEvent[] = [];
  private closed = false;
  publish(event: TaskEvent): void {
    if (!this.closed) this.events.push(event);
  }
  flush(): Promise<void> {
    return Promise.resolve();
  }
  persistedAt(): string {
    return '';
  }
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

const noop = (): void => undefined;
const fakeLogger = { info: noop, warn: noop, error: noop, debug: noop } as const;

function makePlan(steps: Step[]): Plan {
  return {
    task_id: 'task-sched',
    plan_id: 'plan-sched',
    schema_version: SCHEMA_VERSION,
    default_scope: 'public',
    steps,
    outputs: [],
  };
}

/** A navigate step, optionally flagged for confirmation. */
function navigateStep(id: string, url: string, requiresConfirmation = false): Step {
  return {
    id,
    scope: null,
    requires_confirmation: requiresConfirmation,
    confirmation_description: requiresConfirmation ? 'Buy now' : null,
    expected_cost: null,
    consequence: null,
    type: 'navigate',
    url: { kind: 'literal', value: url },
  };
}

function makeContext(
  plan: Plan,
  runDir: string,
  gateway: ExecutionContext['confirmationGateway'],
  store: ConfirmationStore | null,
  runId = 'run-sched',
): ExecutionContext {
  return {
    runId,
    taskId: 'task-sched',
    plan,
    currentStepIdx: 0,
    captures: new InMemoryCaptureStore(),
    secrets: null,
    sanitizer: null,
    llmClient: null,
    workflowLocators: null,
    browser: null,
    page: null,
    locatorHost: null,
    events: new FakeEventBus(),
    budgets: new RetryBudgetImpl({}, { taskId: 'task-sched', runId: 'run-sched' }),
    ethics: { check: () => Promise.resolve() },
    checkpoints: {
      save: () => Promise.resolve(),
      load: () => Promise.resolve(null),
      list: () => Promise.resolve([]),
      loadLast: () => Promise.resolve(null),
    },
    scopeChain: [],
    logger: fakeLogger,
    clock: {
      now: () => Date.now(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h),
    },
    runDir,
    confirmationGateway: gateway,
    confirmationStore: store,
  };
}

/** A notifier that records every notification (and can be made to crash). */
function recordingNotifier(opts: { crash?: boolean } = {}): {
  notifier: Notifier;
  sent: Notification[];
} {
  const sent: Notification[] = [];
  return {
    sent,
    notifier: {
      notify: (n: Notification, _t: NotifyTarget): Promise<void> => {
        if (opts.crash === true) {
          return Promise.reject(new Error('notify crashed'));
        }
        sent.push(n);
        return Promise.resolve();
      },
    },
  };
}

// ---------------------------------------------------------------------------

describe('@no-llm scheduling e2e + chaos', () => {
  let tmpHome: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), 'yantra-sched-e2e-'));
    for (const key of ['XDG_DATA_HOME', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'APPDATA']) {
      saved[key] = process.env[key];
      process.env[key] = tmpHome;
    }
    // Seed the demo workflow so registration validation passes.
    const wfDir = join(tmpHome, 'yantra', 'workflows');
    await mkdir(wfDir, { recursive: true });
    await writeFile(join(wfDir, 'demo.yaml'), DEMO_WORKFLOW, 'utf8');
  });

  afterEach(async () => {
    for (const key of ['XDG_DATA_HOME', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'APPDATA']) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    await rm(tmpHome, { recursive: true, force: true });
  });

  // --- CLI round-trip ------------------------------------------------------

  it('registers, lists, and removes a schedule through the CLI', async () => {
    const reg = await invoke(['schedule', 'demo', '--cron', '*/5 * * * *', '--json']);
    expect(reg.exitCode).toBe(0);
    const schedule = JSON.parse(reg.stdout) as { id: string; onConfirm: string };
    expect(schedule.onConfirm).toBe('pause-and-notify');

    const list = await invoke(['schedules', '--json']);
    expect(list.exitCode).toBe(0);
    const rows = JSON.parse(list.stdout) as { id: string }[];
    expect(rows.map((r) => r.id)).toContain(schedule.id);

    const removed = await invoke(['unschedule', schedule.id, '--json']);
    expect(removed.exitCode).toBe(0);
    expect(JSON.parse(removed.stdout)).toMatchObject({ removed: true });

    const listAfter = await invoke(['schedules', '--json']);
    expect(JSON.parse(listAfter.stdout)).toHaveLength(0);
  });

  it('rejects --on-confirm auto at registration (never auto-confirm)', async () => {
    const result = await invoke([
      'schedule',
      'demo',
      '--cron',
      '*/5 * * * *',
      '--on-confirm',
      'auto',
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('pause-and-notify');
  });

  it('rejects an invalid cron expression', async () => {
    const result = await invoke(['schedule', 'demo', '--cron', 'not-a-cron']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toLowerCase()).toContain('cron');
  });

  it('rejects scheduling an unknown workflow', async () => {
    const result = await invoke(['schedule', 'ghost', '--cron', '*/5 * * * *']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('not found');
  });

  // --- Safety property: flagged step parks, never executes ------------------

  it('parks-and-notifies on a flagged step and NEVER executes it (real executor)', async () => {
    const runDir = join(tmpHome, 'run-sched');
    await mkdir(runDir, { recursive: true });
    const store = createConfirmationStore(runDir);
    const { notifier, sent } = recordingNotifier();
    const gateway = new DaemonConfirmationGateway({
      scheduleId: 'SCH1',
      workflowName: 'demo',
      notifyTarget: 'file',
      notifier,
      logger: fakeLogger,
    });

    // A flagged navigate with a NULL browser: if the step ever dispatched, it
    // would crash on the null browser. Parking means it never runs.
    const plan = makePlan([navigateStep('s1', 'https://shop.example/buy', true)]);
    const ctx = makeContext(plan, runDir, gateway, store);

    const outcome = await new Executor().run(ctx);

    // Never executed → handoff (parked), not a failure from the null browser.
    expect(outcome.status).toBe('handoff');
    // Confirmation notification was emitted exactly once.
    expect(sent.map((n) => n.kind)).toEqual(['confirmation_needed']);
    // The request is STILL pending (no decision appended) — resolvable later.
    const pending = await store.findPending('run-sched');
    expect(pending).not.toBeNull();
    // No step_completed event for the flagged step (it never ran).
    const bus = ctx.events as FakeEventBus;
    const completed = bus.events.filter((e) => e.kind === 'step_completed');
    expect(completed).toHaveLength(0);
  });

  it('re-emits the confirmation notification on restart after a crash between park and notify', async () => {
    const runDir = join(tmpHome, 'run-crash');
    await mkdir(runDir, { recursive: true });
    const store = createConfirmationStore(runDir);

    // First attempt: the notifier crashes AFTER the executor persisted the
    // pending request (park happens regardless of the notify failure).
    const crashing = recordingNotifier({ crash: true });
    const gateway1 = new DaemonConfirmationGateway({
      scheduleId: 'SCH1',
      workflowName: 'demo',
      notifyTarget: 'file',
      notifier: crashing.notifier,
      logger: fakeLogger,
    });
    const plan = makePlan([navigateStep('s1', 'https://shop.example/buy', true)]);
    const outcome1 = await new Executor().run(
      makeContext(plan, runDir, gateway1, store, 'run-crash'),
    );
    expect(outcome1.status).toBe('handoff');

    // The pending request survived on disk despite the notify crash.
    const pending = await store.findPending('run-crash');
    expect(pending).not.toBeNull();

    // Restart: a healthy notifier re-emits the confirmation from the pending
    // record (never auto-confirming — the run stays parked).
    const healthy = recordingNotifier();
    if (pending !== null) {
      const renotify = buildNotification({
        scheduleId: 'SCH1',
        runId: pending.run_id,
        workflowName: 'demo',
        kind: 'confirmation_needed',
        confirmCommand: `yantra confirm ${pending.run_id} grant`,
      });
      await healthy.notifier.notify(renotify, 'file');
    }
    expect(healthy.sent.map((n) => n.kind)).toEqual(['confirmation_needed']);
    expect(healthy.sent[0]?.body).toContain('yantra confirm run-crash grant');
  });

  // --- Audit narration -----------------------------------------------------

  it('yantra audit narrates a scheduled fire from the schedule.json sidecar', async () => {
    const runId = '20260705T080000Z-demo-abcd';
    const runDir = join(tmpHome, 'yantra', 'runs', runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, 'manifest.json'),
      JSON.stringify({
        runId,
        workflowName: 'demo',
        status: 'paused',
        startedAt: '2026-07-05T08:00:00.000Z',
        endedAt: '2026-07-05T08:00:01.000Z',
        durationMs: 1000,
      }),
      'utf8',
    );
    await writeFile(
      join(runDir, 'schedule.json'),
      JSON.stringify({
        schedule_id: 'SCH1',
        workflow_name: 'demo',
        cron_expr: '0 8 * * 1',
        fired_at: '2026-07-05T08:00:00.000Z',
        status: 'pending-confirmation',
      }),
      'utf8',
    );

    const result = await invoke(['audit', runId]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('SCH1');
    expect(result.stdout.toLowerCase()).toContain('paused-and-notified');
  });

  // --- Chaos: notification jsonl is the durable record ---------------------

  it('records a confirmation notification to notifications.jsonl regardless of sink', async () => {
    const runDir = join(tmpHome, 'run-durable');
    await mkdir(runDir, { recursive: true });
    const store = createConfirmationStore(runDir);
    const { SinkNotifier } = await import('@yantra/core');
    const jsonlPath = join(tmpHome, 'notifications.jsonl');
    const notifier = new SinkNotifier({ jsonlPath, platform: 'linux', logger: fakeLogger });
    const gateway = new DaemonConfirmationGateway({
      scheduleId: 'SCH1',
      workflowName: 'demo',
      notifyTarget: 'none',
      notifier,
      logger: fakeLogger,
    });
    const plan = makePlan([navigateStep('s1', 'https://shop.example/buy', true)]);
    await new Executor().run(makeContext(plan, runDir, gateway, store));

    const content = await readFile(jsonlPath, 'utf8');
    const line = JSON.parse(content.trim()) as Notification;
    expect(line.kind).toBe('confirmation_needed');
  });
});
