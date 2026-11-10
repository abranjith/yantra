// @no-llm
/**
 * Reconcile sweeps and the live/orphan queries (FEAT-064 TASK-010, RC4).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ProcessIdentity } from '../../src/browser/installation-types.js';
import { FileBrowserOwnershipRecorder } from '../../src/run-ownership/browser-ownership-recorder.js';
import { claimLease } from '../../src/run-ownership/lease-store.js';
import type { ReconcileResult } from '../../src/run-ownership/reconciler.js';
import {
  findLiveOwners,
  listPossibleOrphans,
  readExecutionState,
  reconcileAll,
} from '../../src/run-ownership/sweep.js';

import { TableProbe, claimInit, cleanupDirs, makeTempDir } from './support.js';

afterEach(cleanupDirs);

async function leasedRun(root: string, runId: string, owner: ProcessIdentity): Promise<string> {
  const runDir = join(root, runId);
  mkdirSync(runDir, { recursive: true });
  await claimLease(runDir, claimInit({ runId }), { identity: owner });
  writeFileSync(join(runDir, 'manifest.json'), JSON.stringify({ runId, status: 'running' }));
  return runDir;
}

const DEAD = { pid: 7001, startToken: 'test:dead' };
const ALIVE = { pid: 7002, startToken: 'test:alive' };
const UNKNOWN = { pid: 7003, startToken: 'test:unknown' };
const SELF = { pid: 7004, startToken: 'test:self' };

function probe(): TableProbe {
  return new TableProbe({
    [`${ALIVE.pid}:${ALIVE.startToken}`]: 'alive',
    [`${UNKNOWN.pid}:${UNKNOWN.startToken}`]: 'unknown',
    [`${SELF.pid}:${SELF.startToken}`]: 'dead',
  });
}

describe('@no-llm reconcileAll', () => {
  it('reconciles dead owners only, skipping its own leases and live or unverifiable owners', async () => {
    const root = makeTempDir();
    await leasedRun(root, 'a-dead', DEAD);
    await leasedRun(root, 'b-alive', ALIVE);
    await leasedRun(root, 'c-unknown', UNKNOWN);
    await leasedRun(root, 'd-self', SELF);
    const visited: string[] = [];
    const checks = probe();
    const result = await reconcileAll({
      trigger: 'list',
      root,
      probe: checks,
      ownPid: SELF.pid,
      reconcile: (runDir) => {
        visited.push(runDir);
        return Promise.resolve({
          kind: 'reconciled',
          outcome: 'failed',
          evidence: 'owner_lost',
          reaped: 0,
          uncertain: 0,
        } satisfies ReconcileResult);
      },
    });
    expect(visited).toEqual([join(root, 'a-dead')]);
    expect(result).toEqual({ scanned: 1, reconciled: ['a-dead'], truncated: false });
    expect(checks.batches).toBe(1);
  });

  it('includes legacy .lock runs, and running manifests without either only when asked', async () => {
    const root = makeTempDir();
    mkdirSync(join(root, 'legacy-lock'));
    writeFileSync(join(root, 'legacy-lock', '.lock'), JSON.stringify({ pid: 1 }));
    mkdirSync(join(root, 'legacy-running'));
    writeFileSync(
      join(root, 'legacy-running', 'manifest.json'),
      JSON.stringify({ status: 'running' }),
    );
    mkdirSync(join(root, 'finished'));
    writeFileSync(join(root, 'finished', 'manifest.json'), JSON.stringify({ status: 'completed' }));
    const visit = (out: string[]) => (runDir: string) => {
      out.push(runDir.split(/[\\/]/u).at(-1) ?? '');
      return Promise.resolve({ kind: 'no_lease' } as const);
    };
    const without: string[] = [];
    await reconcileAll({ trigger: 'cli', root, probe: probe(), reconcile: visit(without) });
    expect(without).toEqual(['legacy-lock']);
    const withRunning: string[] = [];
    await reconcileAll({
      trigger: 'list',
      root,
      probe: probe(),
      includeRunningManifests: true,
      reconcile: visit(withRunning),
    });
    expect(withRunning.sort()).toEqual(['legacy-lock', 'legacy-running']);
  });

  it('stops at its budget, reporting the sweep truncated', async () => {
    const root = makeTempDir();
    for (const name of ['r1', 'r2', 'r3']) await leasedRun(root, name, DEAD);
    let clock = 0;
    const visited: string[] = [];
    const result = await reconcileAll({
      trigger: 'cli',
      root,
      probe: probe(),
      budgetMs: 100,
      now: () => clock,
      reconcile: (runDir) => {
        visited.push(runDir);
        clock += 60;
        return Promise.resolve({ kind: 'busy' } as const);
      },
    });
    expect(visited).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it('keeps sweeping when one reconcile throws', async () => {
    const root = makeTempDir();
    await leasedRun(root, 'r1', DEAD);
    await leasedRun(root, 'r2', DEAD);
    let calls = 0;
    const result = await reconcileAll({
      trigger: 'host',
      root,
      probe: probe(),
      reconcile: () => {
        calls += 1;
        return calls === 1
          ? Promise.reject(new Error('disk'))
          : Promise.resolve({
              kind: 'reconciled',
              outcome: 'failed',
              evidence: 'owner_lost',
              reaped: 0,
              uncertain: 0,
            } as const);
      },
    });
    expect(calls).toBe(2);
    expect(result.reconciled).toHaveLength(1);
  });

  it('really reconciles a dead owner end to end', async () => {
    const root = makeTempDir();
    const runDir = await leasedRun(root, 'real', DEAD);
    await reconcileAll({ trigger: 'list', root, probe: probe() });
    expect(await readExecutionState(runDir)).toBe('interrupted');
  });
});

describe('@no-llm findLiveOwners and listPossibleOrphans', () => {
  it('lists alive and unknown owners for the data-dir guard', async () => {
    const root = makeTempDir();
    await leasedRun(root, 'a', DEAD);
    await leasedRun(root, 'b', ALIVE);
    await leasedRun(root, 'c', UNKNOWN);
    const live = await findLiveOwners({ root, probe: probe() });
    expect(live.sort((x, y) => x.runId.localeCompare(y.runId))).toEqual([
      { runId: 'b', pid: ALIVE.pid, origin: 'terminal', verdict: 'alive' },
      { runId: 'c', pid: UNKNOWN.pid, origin: 'terminal', verdict: 'unknown' },
    ]);
  });

  it('lists dead-owner leases that still record browsers', async () => {
    const root = makeTempDir();
    const orphaned = await leasedRun(root, 'orphaned', DEAD);
    await leasedRun(root, 'clean', DEAD);
    const live = await leasedRun(root, 'live', ALIVE);
    const browser = { pid: 9300, startToken: 'test:9300' };
    await new FileBrowserOwnershipRecorder(orphaned).recordSpawned(browser);
    await new FileBrowserOwnershipRecorder(live).recordSpawned(browser);
    expect(await listPossibleOrphans({ root, probe: probe() })).toEqual([
      { runId: 'orphaned', runDir: orphaned, browsers: [browser] },
    ]);
  });

  it('returns nothing for a missing runs root', async () => {
    const root = join(makeTempDir(), 'missing');
    expect(await findLiveOwners({ root, probe: probe() })).toEqual([]);
    expect(await reconcileAll({ trigger: 'list', root, probe: probe() })).toEqual({
      scanned: 0,
      reconciled: [],
      truncated: false,
    });
  });
});
