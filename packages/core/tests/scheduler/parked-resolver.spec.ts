import type { ConfirmationDecision } from '@yantra/protocol';
import { describe, expect, it, vi } from 'vitest';

import { isParked } from '../../src/executor/confirmation-gateway.js';
import type { LastFireStatus } from '../../src/index-db/schedule-store.js';
import { resolveParkedRun } from '../../src/scheduler/parked-resolver.js';
import { PreGrantedConfirmationGateway } from '../../src/scheduler/pregranted-confirmation-gateway.js';

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

function decision(kind: 'granted' | 'denied' | 'timed_out'): ConfirmationDecision {
  return {
    confirmation_id: 'C1',
    decision: kind,
    decided_at: '2026-07-05T01:00:00.000Z',
    decided_by: 'user_cli_confirm',
  };
}

describe('@no-llm resolveParkedRun', () => {
  it('returns null (still parked) when there is no run id', async () => {
    const result = await resolveParkedRun(null, {
      reader: { latestDecision: () => Promise.resolve(null) },
      resume: { resume: () => Promise.reject(new Error('should not resume')) },
      logger: silentLogger,
    });
    expect(result).toBeNull();
  });

  it('returns null (still parked) when no decision has been made yet', async () => {
    const resumeSpy = vi.fn();
    const result = await resolveParkedRun('run-1', {
      reader: { latestDecision: () => Promise.resolve(null) },
      resume: { resume: resumeSpy },
      logger: silentLogger,
    });
    expect(result).toBeNull();
    expect(resumeSpy).not.toHaveBeenCalled();
  });

  it('resumes the run when the decision is granted', async () => {
    const resumeSpy = vi.fn(() =>
      Promise.resolve({ status: 'succeeded' as LastFireStatus, runId: 'run-1' }),
    );
    const result = await resolveParkedRun('run-1', {
      reader: { latestDecision: () => Promise.resolve(decision('granted')) },
      resume: { resume: resumeSpy },
      logger: silentLogger,
    });
    expect(resumeSpy).toHaveBeenCalledWith('run-1');
    expect(result).toEqual({ runId: 'run-1', status: 'succeeded' });
  });

  it('finalizes as handoff without resuming when the decision is denied', async () => {
    const resumeSpy = vi.fn();
    const result = await resolveParkedRun('run-1', {
      reader: { latestDecision: () => Promise.resolve(decision('denied')) },
      resume: { resume: resumeSpy },
      logger: silentLogger,
    });
    expect(resumeSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ runId: 'run-1', status: 'handoff' });
  });
});

describe('@no-llm PreGrantedConfirmationGateway', () => {
  const request = {
    confirmation_id: 'C1',
    run_id: 'run-1',
    step_id: 's2',
    action_kind: 'click' as const,
    host: 'shop.example',
    description: 'Buy',
    expected_cost: null,
    consequence: 'unknown' as const,
    requested_at: '2026-07-05T00:05:00.000Z',
    timeout_ms: null,
  };

  it('grants the first request (replaying the human grant)', async () => {
    const gateway = new PreGrantedConfirmationGateway({ logger: silentLogger });
    const outcome = await gateway.request(request);
    expect(isParked(outcome)).toBe(false);
    if (!isParked(outcome)) {
      expect(outcome.decision).toBe('granted');
      expect(outcome.decided_by).toBe('user_cli_confirm');
    }
  });

  it('denies a SECOND request in the same run (only one prior grant to replay)', async () => {
    const gateway = new PreGrantedConfirmationGateway({ logger: silentLogger });
    await gateway.request(request);
    const second = await gateway.request({ ...request, confirmation_id: 'C2', step_id: 's5' });
    expect(isParked(second)).toBe(false);
    if (!isParked(second)) {
      expect(second.decision).toBe('denied');
    }
  });
});
