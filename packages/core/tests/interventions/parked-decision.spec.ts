import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfirmationStore } from '@yantra/core';
import { describe, expect, it } from 'vitest';

import { ParkedDecisionService } from '../../src/interventions/parked-decision.js';

const request = {
  confirmation_id: '01J00000000000000000000010',
  run_id: 'run-1',
  step_id: 'step-1',
  action_kind: 'click' as const,
  host: 'shop.example',
  description: 'Confirm checkout',
  expected_cost: null,
  consequence: 'unknown' as const,
  requested_at: '2026-11-03T12:00:00.000Z',
  timeout_ms: null,
};

async function fixture() {
  const runDir = await mkdtemp(join(tmpdir(), 'yantra-parked-decision-'));
  const store = new ConfirmationStore(join(runDir, 'confirmations.jsonl'));
  await store.appendRequest(request);
  return { runDir, store };
}

describe('@no-llm ParkedDecisionService', () => {
  it('lets exactly one of 20 concurrent callers claim a request', async () => {
    const { runDir, store } = await fixture();
    try {
      const service = new ParkedDecisionService();
      const responses = await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          service.decideParked({
            runDir,
            runId: 'run-1',
            decision: index % 2 === 0 ? 'granted' : 'denied',
            decidedBy: 'user_cli_confirm',
            now: '2026-11-03T12:01:00.000Z',
          }),
        ),
      );

      expect(responses.filter((response) => response.status === 'accepted')).toHaveLength(1);
      expect(responses.filter((response) => response.status === 'already_decided')).toHaveLength(
        19,
      );
      const accepted = responses.find((response) => response.status === 'accepted');
      const duplicate = responses.find((response) => response.status === 'already_decided');
      expect(accepted?.status).toBe('accepted');
      expect(duplicate?.status).toBe('already_decided');
      if (accepted?.status === 'accepted' && duplicate?.status === 'already_decided') {
        expect(duplicate.decision).toBe(accepted.decision.decision);
        expect(duplicate.decided_at).toBe(accepted.decision.decided_at);
      }

      const entries = await store.readAll();
      expect(entries.filter((entry) => entry.kind === 'decision')).toHaveLength(1);
      const claims = await readdir(join(runDir, 'decisions'));
      expect(claims).toEqual([`${request.confirmation_id}.json`]);
      expect((await readFile(join(runDir, 'decisions', claims[0]!), 'utf8')).endsWith('\n')).toBe(
        true,
      );
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  });

  it('repairs a projection after a crash between claim publication and append', async () => {
    const { runDir, store } = await fixture();
    try {
      const service = new ParkedDecisionService();
      const response = await service.decideParked({
        runDir,
        runId: 'run-1',
        decision: 'granted',
        decidedBy: 'user_cli_confirm',
      });
      expect(response.status).toBe('accepted');

      const content = await readFile(join(runDir, 'confirmations.jsonl'), 'utf8');
      await writeFile(join(runDir, 'confirmations.jsonl'), `${content.split('\n')[0]}\n`);
      await service.repairClaimProjection(runDir);
      await service.repairClaimProjection(runDir);

      const decision = await store.latestDecision('run-1');
      expect(decision?.decision).toBe('granted');
      expect((await store.readAll()).filter((entry) => entry.kind === 'decision')).toHaveLength(1);
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  });

  it('fails closed for a corrupt claim', async () => {
    const { runDir, store } = await fixture();
    try {
      const decisionsDir = join(runDir, 'decisions');
      await mkdir(decisionsDir, { recursive: true });
      await writeFile(join(decisionsDir, `${request.confirmation_id}.json`), '{not-json');
      const service = new ParkedDecisionService();

      const response = await service.decideParked({
        runDir,
        runId: 'run-1',
        decision: 'granted',
        decidedBy: 'user_cli_confirm',
      });
      expect(response).toMatchObject({ status: 'already_decided', decision: 'denied' });
      expect((await store.latestDecision('run-1'))?.decision).toBe('denied');
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  });
  describe('expected confirmation id (REV-001)', () => {
    it('decides the pending request when its id matches', async () => {
      const { runDir, store } = await fixture();
      try {
        const response = await new ParkedDecisionService().decideParked({
          runDir,
          runId: 'run-1',
          decision: 'granted',
          decidedBy: 'user_app',
          confirmationId: request.confirmation_id,
        });
        expect(response.status).toBe('accepted');
        expect((await store.readAll()).filter((entry) => entry.kind === 'decision')).toHaveLength(
          1,
        );
      } finally {
        await rm(runDir, { recursive: true, force: true });
      }
    });

    it('returns stale unknown_id and writes nothing for an id the run never raised', async () => {
      const { runDir, store } = await fixture();
      try {
        const response = await new ParkedDecisionService().decideParked({
          runDir,
          runId: 'run-1',
          decision: 'granted',
          decidedBy: 'user_app',
          confirmationId: '01J000000000000000000000ZZ',
        });
        expect(response).toEqual({ status: 'stale', reason: 'unknown_id' });
        expect((await store.readAll()).filter((entry) => entry.kind === 'decision')).toHaveLength(
          0,
        );
        await expect(readdir(join(runDir, 'decisions'))).rejects.toThrow();
      } finally {
        await rm(runDir, { recursive: true, force: true });
      }
    });

    it('does not decide a newer pending request when a stale card answers an older one', async () => {
      const { runDir, store } = await fixture();
      try {
        const service = new ParkedDecisionService();
        await service.decideParked({
          runDir,
          runId: 'run-1',
          decision: 'denied',
          decidedBy: 'user_cli_confirm',
          now: '2026-11-03T12:01:00.000Z',
        });
        const newer = { ...request, confirmation_id: '01J00000000000000000000020' };
        await store.appendRequest(newer);

        const response = await service.decideParked({
          runDir,
          runId: 'run-1',
          decision: 'granted',
          decidedBy: 'user_app',
          confirmationId: request.confirmation_id,
        });

        expect(response).toMatchObject({ status: 'already_decided', decision: 'denied' });
        expect(await store.findPending('run-1')).toMatchObject({
          confirmation_id: newer.confirmation_id,
        });
        expect(await readdir(join(runDir, 'decisions'))).toEqual([
          `${request.confirmation_id}.json`,
        ]);
      } finally {
        await rm(runDir, { recursive: true, force: true });
      }
    });

    it('returns stale not_waiting for a raised request that has no decision and is not pending', async () => {
      const { runDir, store } = await fixture();
      try {
        const newer = { ...request, confirmation_id: '01J00000000000000000000030' };
        await store.appendRequest(newer);
        const pending = await store.findPending('run-1');
        const other =
          pending?.confirmation_id === newer.confirmation_id
            ? request.confirmation_id
            : newer.confirmation_id;

        const response = await new ParkedDecisionService().decideParked({
          runDir,
          runId: 'run-1',
          decision: 'granted',
          decidedBy: 'user_app',
          confirmationId: other,
        });

        expect(response).toEqual({ status: 'stale', reason: 'not_waiting' });
        expect((await store.readAll()).filter((entry) => entry.kind === 'decision')).toHaveLength(
          0,
        );
      } finally {
        await rm(runDir, { recursive: true, force: true });
      }
    });
  });
});
