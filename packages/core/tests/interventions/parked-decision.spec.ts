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
});
