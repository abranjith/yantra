import type { ConfirmationDecision } from '@yantra/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { LastFireStatus } from '../../src/index-db/schedule-store.js';
import { resolveParkedRun } from '../../src/scheduler/parked-resolver.js';

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
