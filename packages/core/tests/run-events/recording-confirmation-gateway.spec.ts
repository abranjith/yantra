// @no-llm
import { join } from 'node:path';

import {
  SCHEMA_VERSION,
  type ConfirmationDecision,
  type ConfirmationRequest,
  type Plan,
  type RunEventRecordType,
} from '@yantra/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Page } from '../../src/browser/types.js';
import type { ConfirmationOutcome } from '../../src/executor/confirmation-gateway.js';
import { createExecutionContext } from '../../src/executor/execution-context.js';
import { Executor } from '../../src/executor/executor.js';
import { RUN_EVENTS_FILENAME } from '../../src/run-events/log.js';
import { readRunEvents } from '../../src/run-events/reader.js';
import {
  RecordingConfirmationGateway,
  requestDeadline,
} from '../../src/run-events/recording-confirmation-gateway.js';
import { RunEventStream } from '../../src/run-events/stream.js';

import {
  AT,
  CONFIRMATION_ID,
  ManualScheduler,
  cleanupRunDirs,
  makeRunDir,
  silentLogger,
} from './support.js';

afterEach(cleanupRunDirs);

const request: ConfirmationRequest = {
  confirmation_id: CONFIRMATION_ID,
  run_id: 'run-1',
  step_id: 's1',
  action_kind: 'navigate',
  host: 'shop.example',
  description: 'Open the checkout page',
  expected_cost: null,
  consequence: 'reversible',
  requested_at: AT,
  timeout_ms: 60_000,
};

function decision(
  value: ConfirmationDecision['decision'],
  by: ConfirmationDecision['decided_by'],
): ConfirmationDecision {
  return {
    confirmation_id: CONFIRMATION_ID,
    decision: value,
    decided_at: '2026-11-01T12:00:05.000Z',
    decided_by: by,
  };
}

async function records(runDir: string): Promise<RunEventRecordType[]> {
  const out: RunEventRecordType[] = [];
  for await (const item of readRunEvents(join(runDir, RUN_EVENTS_FILENAME))) {
    if (item.status === 'event') out.push(item.record);
  }
  return out;
}

async function openStream(sync: (fd: number) => void = () => undefined) {
  const runDir = await makeRunDir();
  const stream = new RunEventStream();
  stream.open({ runDir, runId: 'run-1', sync, scheduler: new ManualScheduler() });
  return { runDir, stream };
}

describe('@no-llm RecordingConfirmationGateway', () => {
  it.each([
    ['granted', 'user_interactive'],
    ['denied', 'user_cli_confirm'],
    ['timed_out', 'timeout'],
    ['granted', 'user_app'],
  ] as const)('records raised → resolved for %s by %s', async (value, by) => {
    const { runDir, stream } = await openStream();
    const gateway = new RecordingConfirmationGateway(
      { request: () => Promise.resolve(decision(value, by)) },
      stream,
      { now: () => AT },
    );

    const outcome = await gateway.request(request);
    stream.close();
    const rs = await records(runDir);

    expect(outcome).toEqual(decision(value, by));
    expect(rs.map((r) => r.event)).toEqual([
      {
        kind: 'intervention_raised',
        intervention_id: CONFIRMATION_ID,
        intervention_kind: 'confirmation',
        request,
        deadline_at: '2026-11-01T12:01:00.000Z',
        at: AT,
      },
      {
        kind: 'intervention_resolved',
        intervention_id: CONFIRMATION_ID,
        decision: value,
        decided_by: by,
        decided_at: '2026-11-01T12:00:05.000Z',
        at: AT,
      },
    ]);
  });

  it('records raised only and rethrows the same error when the inner gateway throws', async () => {
    const { runDir, stream } = await openStream();
    const failure = new Error('run aborted');
    const gateway = new RecordingConfirmationGateway(
      { request: () => Promise.reject(failure) },
      stream,
    );

    await expect(gateway.request(request)).rejects.toBe(failure);
    stream.close();

    expect((await records(runDir)).map((r) => r.event.kind)).toEqual(['intervention_raised']);
  });

  it('leaves a parked request raised, with no deadline for an indefinite wait', async () => {
    const { runDir, stream } = await openStream();
    const gateway = new RecordingConfirmationGateway<ConfirmationOutcome>(
      { request: () => Promise.resolve({ kind: 'parked' }) },
      stream,
    );

    const outcome = await gateway.request({ ...request, timeout_ms: null });
    stream.close();
    const rs = await records(runDir);

    expect(outcome).toEqual({ kind: 'parked' });
    expect(rs.map((r) => r.event)).toEqual([
      expect.objectContaining({ kind: 'intervention_raised', deadline_at: null }),
    ]);
  });

  it('uses an injected deadline when the caller knows a tighter one', async () => {
    const { runDir, stream } = await openStream();
    const gateway = new RecordingConfirmationGateway(
      { request: () => Promise.resolve(decision('granted', 'user_interactive')) },
      stream,
      { deadlineFor: () => '2026-11-01T12:00:30.000Z' },
    );

    await gateway.request(request);
    stream.close();

    expect((await records(runDir))[0]?.event).toMatchObject({
      deadline_at: '2026-11-01T12:00:30.000Z',
    });
  });

  it('syncs the log after each intervention event', async () => {
    const sync = vi.fn();
    const { stream } = await openStream(sync);
    const gateway = new RecordingConfirmationGateway(
      { request: () => Promise.resolve(decision('granted', 'user_interactive')) },
      stream,
    );

    await gateway.request(request);
    expect(sync).toHaveBeenCalledTimes(2);
    stream.close();
  });

  it('computes the request deadline from requested_at and timeout_ms', () => {
    expect(requestDeadline(request)).toBe('2026-11-01T12:01:00.000Z');
    expect(requestDeadline({ ...request, timeout_ms: null })).toBeNull();
    expect(requestDeadline({ ...request, requested_at: 'garbage' })).toBeNull();
  });
});

describe('@no-llm executor consent in run-events.jsonl', () => {
  function plan(): Plan {
    return {
      task_id: 'task-1',
      plan_id: 'plan-1',
      schema_version: SCHEMA_VERSION,
      default_scope: 'public',
      steps: [
        {
          id: 's1',
          scope: null,
          requires_confirmation: true,
          confirmation_description: 'Open the checkout page',
          expected_cost: null,
          consequence: 'reversible',
          type: 'navigate',
          url: { kind: 'literal', value: 'https://shop.example/checkout' },
        },
      ],
      outputs: [],
    } as Plan;
  }

  it.each([
    ['granted', 'user_interactive'],
    ['denied', 'user_interactive'],
  ] as const)('orders a %s wait as requested → raised → resolved → resolved', async (value, by) => {
    const { runDir, stream } = await openStream();
    const page = {
      goto: () => Promise.resolve(null),
      url: () => 'https://shop.example/checkout',
    } as unknown as Page;
    const ctx = createExecutionContext({
      runId: 'run-1',
      taskId: 'task-1',
      plan: plan(),
      runDir,
      page,
      ethics: { check: () => Promise.resolve() },
      logger: silentLogger,
      confirmationGateway: {
        request: (req) =>
          Promise.resolve({ ...decision(value, by), confirmation_id: req.confirmation_id }),
      },
      runEvents: stream,
    });

    await new Executor().run(ctx);
    stream.close();
    const kinds = (await records(runDir))
      .map((r) => r.event.kind)
      .filter((k) => k.startsWith('confirmation_') || k.startsWith('intervention_'));

    expect(kinds).toEqual([
      'confirmation_requested',
      'intervention_raised',
      'intervention_resolved',
      'confirmation_resolved',
    ]);
    const rs = await records(runDir);
    const raised = rs.find((r) => r.event.kind === 'intervention_raised')?.event as {
      intervention_id: string;
    };
    const resolved = rs.find((r) => r.event.kind === 'confirmation_resolved')?.event as {
      confirmation_id: string;
    };
    expect(raised.intervention_id).toBe(resolved.confirmation_id);
  });

  it('does not wrap the gateway when no stream is given', async () => {
    const runDir = await makeRunDir();
    const gateway = { request: () => Promise.resolve(decision('granted', 'user_interactive')) };
    const ctx = createExecutionContext({
      taskId: 'task-1',
      plan: plan(),
      runDir,
      ethics: { check: () => Promise.resolve() },
      logger: silentLogger,
      confirmationGateway: gateway,
    });

    expect(ctx.confirmationGateway).toBe(gateway);
  });
});
