// @no-llm
/**
 * Resume takeover (FEAT-064 TASK-010, amended by spike S2 RC2).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { RunEventLog } from '../../src/run-events/log.js';
import { FileBrowserOwnershipRecorder } from '../../src/run-ownership/browser-ownership-recorder.js';
import { RunLeaseHeldError } from '../../src/run-ownership/errors.js';
import { claimLease, readLease, readOwnedBrowsers } from '../../src/run-ownership/lease-store.js';
import { claimExistingRun } from '../../src/run-ownership/takeover.js';
import { assistantText, taskStarted } from '../run-events/support.js';

import { OWNER, TableProbe, claimInit, cleanupDirs, makeTempDir } from './support.js';

afterEach(cleanupDirs);

const NEW_OWNER = { pid: 5000, startToken: 'test:new' };

async function deadRun(): Promise<string> {
  const runDir = makeTempDir();
  await claimLease(runDir, claimInit(), { identity: OWNER });
  writeFileSync(
    join(runDir, 'manifest.json'),
    JSON.stringify({ runId: 'r', startedAt: '2026-11-09T12:00:00.000Z', status: 'running' }),
  );
  const log = RunEventLog.open({ runDir, runId: 'r', sync: () => undefined });
  log.append(taskStarted());
  log.append(assistantText('working'));
  log.close();
  return runDir;
}

function outcomeSeqs(runDir: string): number[] {
  return readFileSync(join(runDir, 'run-events.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { seq: number; event: { kind: string } })
    .filter((line) => line.event.kind === 'run_outcome')
    .map((line) => line.seq);
}

describe('@no-llm claimExistingRun', () => {
  it('claims a run with no lease plainly, at the log tail', async () => {
    const runDir = makeTempDir();
    const log = RunEventLog.open({ runDir, runId: 'r', sync: () => undefined });
    log.append(taskStarted());
    log.close();
    const lease = await claimExistingRun(runDir, claimInit({ command: ['resume'] }), {
      identity: NEW_OWNER,
    });
    expect(lease).toMatchObject({ owner: { pid: NEW_OWNER.pid }, log_seq_at_claim: 1 });
  });

  it.each(['alive', 'unknown'] as const)(
    'answers busy for an owner that is %s',
    async (verdict) => {
      const runDir = await deadRun();
      const probe = new TableProbe({ [`${OWNER.pid}:${OWNER.startToken}`]: verdict });
      const error = await claimExistingRun(runDir, claimInit(), {
        identity: NEW_OWNER,
        probe,
      }).catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(RunLeaseHeldError);
      expect((error as RunLeaseHeldError).verdict).toBe(verdict);
      expect((error as Error).message).toContain(`pid ${OWNER.pid}`);
      const read = await readLease(runDir);
      expect(read.kind === 'lease' && read.lease.owner.pid).toBe(OWNER.pid);
    },
  );

  it('reconciles a dead owner first, then claims above its owner_lost outcome', async () => {
    const runDir = await deadRun();
    const lease = await claimExistingRun(runDir, claimInit({ command: ['resume'] }), {
      identity: NEW_OWNER,
      probe: new TableProbe(),
    });
    expect(outcomeSeqs(runDir)).toEqual([3]);
    expect(lease.log_seq_at_claim).toBe(3);
    expect(lease.owner).toEqual({ pid: NEW_OWNER.pid, start_token: NEW_OWNER.startToken });
    const read = await readLease(runDir);
    expect(read.kind === 'lease' && read.lease.run_token).toBe(lease.run_token);
  });

  it('lets exactly one of two concurrent takeovers own the run', async () => {
    const runDir = await deadRun();
    const results = await Promise.allSettled([
      claimExistingRun(runDir, claimInit(), { identity: NEW_OWNER, probe: new TableProbe() }),
      claimExistingRun(runDir, claimInit(), {
        identity: { pid: 5001, startToken: 'test:other' },
        probe: new TableProbe(),
      }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(RunLeaseHeldError);
    expect(outcomeSeqs(runDir)).toHaveLength(1);
  });

  it('carries uncertain browsers over to the new owner', async () => {
    const runDir = await deadRun();
    const browser = { pid: 9200, startToken: 'test:9200' };
    await new FileBrowserOwnershipRecorder(runDir).recordSpawned(browser);
    const probe = new TableProbe({ [`${browser.pid}:${browser.startToken}`]: 'unknown' });
    await claimExistingRun(runDir, claimInit(), { identity: NEW_OWNER, probe });
    expect(await readOwnedBrowsers(runDir)).toEqual([browser]);
    const read = await readLease(runDir);
    expect(read.kind === 'lease' && read.lease.owner.pid).toBe(NEW_OWNER.pid);
  });

  it('leaves no reconcile.lock behind', async () => {
    const runDir = await deadRun();
    await claimExistingRun(runDir, claimInit(), { identity: NEW_OWNER, probe: new TableProbe() });
    expect(existsSync(join(runDir, 'reconcile.lock'))).toBe(false);
  });
});
