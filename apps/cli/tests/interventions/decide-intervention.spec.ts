// @no-llm
/**
 * REV-001: one answer path for `yantra confirm` and the app host. A live
 * owner decides; a parked claim is written only for a run with no live
 * owner, and only for the request the user answered; an owner that may be
 * alive but cannot decide leaves nothing written.
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ConfirmationStore,
  RunInterventions,
  RunOwnershipSession,
  resetPathCache,
  runsRoot,
} from '@yantra/core';
import type { ConfirmationRequest } from '@yantra/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  decideIntervention,
  tryLiveDecision,
} from '../../src/interventions/decide-intervention.js';

const RUN_ID = '20261121T100000Z-shop-0000abcd';
const ID = '01J00000000000000000000001';

function request(id = ID): ConfirmationRequest {
  return {
    confirmation_id: id,
    run_id: RUN_ID,
    step_id: 'step-1',
    action_kind: 'click',
    host: 'shop.example',
    description: 'Place the order',
    expected_cost: null,
    consequence: 'irreversible',
    requested_at: new Date().toISOString(),
    timeout_ms: 60_000,
  };
}

let home: string;
let runDir: string;
const sessions: RunOwnershipSession[] = [];

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'yd-'));
  vi.stubEnv('YANTRA_HOME', home);
  resetPathCache();
  runDir = join(runsRoot(), RUN_ID);
  await mkdir(runDir, { recursive: true });
});

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.finish()));
  vi.unstubAllEnvs();
  resetPathCache();
  await rm(home, { recursive: true, force: true });
});

async function liveOwner(serveInterventions: boolean) {
  const session = await RunOwnershipSession.open({
    runDir,
    runId: RUN_ID,
    origin: 'worker',
    executionClass: 'run',
    command: ['run', 'fixture'],
  });
  sessions.push(session);
  const runs = new RunInterventions({ initialAttendance: 0, runsRoot });
  if (serveInterventions) runs.attachRun(RUN_ID, { channel: session });
  return runs.authorityFor(RUN_ID);
}

async function pendingInFile(...ids: string[]): Promise<ConfirmationStore> {
  const store = new ConfirmationStore(join(runDir, 'confirmations.jsonl'));
  for (const id of ids) await store.appendRequest(request(id));
  return store;
}

const decisionsWritten = () => existsSync(join(runDir, 'decisions'));

describe('a run with a live owner', () => {
  it('is decided by the owner, with the answering surface recorded and no parked claim', async () => {
    const authority = await liveOwner(true);
    await pendingInFile(ID);
    const waiting = authority.raise(request());

    const outcome = await decideIntervention({
      runDir,
      runId: RUN_ID,
      confirmationId: ID,
      decision: 'granted',
      decidedBy: 'user_app',
    });

    expect(outcome).toMatchObject({
      kind: 'decided',
      case: 'live',
      response: { status: 'accepted', decision: { decided_by: 'user_app' } },
    });
    await expect(waiting).resolves.toMatchObject({ decision: 'granted', decided_by: 'user_app' });
    expect(decisionsWritten()).toBe(false);
  });

  it('is unreachable, writing nothing, when the owner does not serve interventions', async () => {
    await liveOwner(false);
    const store = await pendingInFile(ID);

    const outcome = await decideIntervention({
      runDir,
      runId: RUN_ID,
      confirmationId: ID,
      decision: 'granted',
      decidedBy: 'user_app',
    });

    expect(outcome).toEqual({ kind: 'owner_unreachable', reason: 'unavailable' });
    expect(decisionsWritten()).toBe(false);
    expect((await store.readAll()).filter((entry) => entry.kind === 'decision')).toEqual([]);
  });

  it('is unreachable, writing nothing, when the owner does not answer in time', async () => {
    await pendingInFile(ID);
    const attempt = vi.fn(() => Promise.resolve('unreachable' as const));

    const outcome = await decideIntervention(
      { runDir, runId: RUN_ID, confirmationId: ID, decision: 'denied', decidedBy: 'user_app' },
      attempt,
    );

    expect(outcome).toEqual({ kind: 'owner_unreachable', reason: 'unreachable' });
    expect(decisionsWritten()).toBe(false);
  });
});

describe('a run without a live owner', () => {
  it('tryLiveDecision reports no owner when there is no lease', async () => {
    await expect(tryLiveDecision(runDir, ID, 'granted', 'user_app')).resolves.toBeNull();
  });

  it('is decided by a parked claim for exactly the answered request', async () => {
    const store = await pendingInFile(ID);

    const outcome = await decideIntervention({
      runDir,
      runId: RUN_ID,
      confirmationId: ID,
      decision: 'granted',
      decidedBy: 'user_app',
    });

    expect(outcome).toMatchObject({
      kind: 'decided',
      case: 'parked',
      response: { status: 'accepted' },
    });
    const decisions = (await store.readAll()).filter((entry) => entry.kind === 'decision');
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.data).toMatchObject({ confirmation_id: ID, decided_by: 'user_app' });
  });

  it('is stale, and decides nothing, for a request other than the pending one', async () => {
    const store = await pendingInFile(ID);

    const outcome = await decideIntervention({
      runDir,
      runId: RUN_ID,
      confirmationId: '01J000000000000000000000ZZ',
      decision: 'granted',
      decidedBy: 'user_app',
    });

    expect(outcome).toEqual({
      kind: 'decided',
      case: 'parked',
      response: { status: 'stale', reason: 'unknown_id' },
    });
    expect(decisionsWritten()).toBe(false);
    expect((await store.readAll()).filter((entry) => entry.kind === 'decision')).toEqual([]);
  });
});
