import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { InterventionAuthority } from '../../src/interventions/authority.js';
import { UnattendedCeilingClock } from '../../src/interventions/deadline.js';
import { InterventionLog } from '../../src/interventions/intervention-log.js';

const request = {
  confirmation_id: '01J00000000000000000000030',
  run_id: 'run-authority',
  step_id: 'step-1',
  action_kind: 'click' as const,
  host: 'shop.example',
  description: 'Approve checkout',
  expected_cost: null,
  consequence: 'unknown' as const,
  requested_at: '2026-11-03T12:00:00.000Z',
  timeout_ms: null,
};

function authority(runDir: string, now: () => string, flush = vi.fn(async () => undefined)) {
  const events = { publish: vi.fn(), flush };
  const ceiling = new UnattendedCeilingClock({ now: () => Date.parse(now()) });
  ceiling.setAttendance(1);
  return {
    authority: new InterventionAuthority({
      runId: request.run_id,
      log: new InterventionLog(join(runDir, 'interventions.jsonl')),
      events,
      clock: { now },
      ceiling,
    }),
    events,
    flush,
  };
}

describe('@no-llm InterventionAuthority', () => {
  it('accepts one answer and reports the winner to a duplicate', async () => {
    const runDir = await mkdtemp(join(tmpdir(), 'yantra-authority-'));
    try {
      let current = '2026-11-03T12:00:00.000Z';
      const built = authority(runDir, () => current);
      const waiting = built.authority.raise(request);
      await new Promise<void>((resolve) => setImmediate(resolve));
      const [first, second] = await Promise.all([
        built.authority.answer({
          interventionId: request.confirmation_id,
          decision: 'granted',
          decidedBy: 'user_app',
        }),
        built.authority.answer({
          interventionId: request.confirmation_id,
          decision: 'denied',
          decidedBy: 'user_cli_confirm',
        }),
      ]);
      current = '2026-11-03T12:00:01.000Z';
      const decision = await waiting;
      expect([first.status, second.status].sort()).toEqual(['accepted', 'already_decided']);
      expect(decision.decision).toBe('granted');
      expect(
        (await new InterventionLog(join(runDir, 'interventions.jsonl')).readAll()).filter(
          (entry) => entry.entry === 'resolved',
        ),
      ).toHaveLength(1);
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  });

  it('evaluates expiry before accepting a late answer', async () => {
    const runDir = await mkdtemp(join(tmpdir(), 'yantra-authority-expiry-'));
    try {
      let current = Date.parse('2026-11-03T12:00:00.000Z');
      const built = authority(runDir, () => new Date(current).toISOString());
      const waiting = built.authority.raise(request, { agentConfirmTimeoutMs: 1_000 });
      await new Promise<void>((resolve) => setImmediate(resolve));
      current += 1_001;
      const response = await built.authority.answer({
        interventionId: request.confirmation_id,
        decision: 'granted',
        decidedBy: 'user_app',
      });
      expect(response.status).toBe('expired');
      await expect(waiting).resolves.toMatchObject({ decision: 'timed_out' });
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  });

  it('returns stale for an unknown intervention and waits for flush before accepting', async () => {
    const runDir = await mkdtemp(join(tmpdir(), 'yantra-authority-stale-'));
    try {
      const flush = vi.fn(async () => undefined);
      const built = authority(runDir, () => '2026-11-03T12:00:00.000Z', flush);
      await expect(
        built.authority.answer({
          interventionId: '01J00000000000000000000031',
          decision: 'granted',
          decidedBy: 'user_app',
        }),
      ).resolves.toEqual({ status: 'stale', reason: 'unknown_id' });
      const waiting = built.authority.raise(request);
      await new Promise<void>((resolve) => setImmediate(resolve));
      const response = await built.authority.answer({
        interventionId: request.confirmation_id,
        decision: 'denied',
        decidedBy: 'user_app',
      });
      expect(response.status).toBe('accepted');
      expect(flush).toHaveBeenCalled();
      await expect(waiting).resolves.toMatchObject({ decision: 'denied' });
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  });
});
