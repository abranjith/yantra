// @no-llm
/**
 * The reconciler (FEAT-064 TASK-009): exactly one terminal result for a dead
 * owner, identity-verified browser reaping, crash-safe re-runs.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import type { RunEventType } from '@yantra/protocol';
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';

import type { ProcessIdentity } from '../../src/browser/installation-types.js';
import { RunEventLog, RUN_EVENTS_FILENAME } from '../../src/run-events/log.js';
import { FileBrowserOwnershipRecorder } from '../../src/run-ownership/browser-ownership-recorder.js';
import { LEGACY_LOCK_FILENAME, RUN_LEASE_FILENAME } from '../../src/run-ownership/constants.js';
import { claimLease, readOwnedBrowsers } from '../../src/run-ownership/lease-store.js';
import { reconcileRun, type ReconcileDeps } from '../../src/run-ownership/reconciler.js';
import { AT, assistantText, runOutcome, taskStarted } from '../run-events/support.js';

import { OWNER, TableProbe, claimInit, cleanupDirs, makeTempDir } from './support.js';

afterEach(cleanupDirs);

const NOW = new Date('2026-11-09T13:00:00.000Z');
const BROWSER: ProcessIdentity = { pid: 9100, startToken: 'test:9100' };

function writeManifest(runDir: string, fields: Record<string, unknown> = {}): void {
  writeFileSync(
    join(runDir, 'manifest.json'),
    JSON.stringify({
      runId: runDir.split(/[\\/]/u).at(-1),
      taskId: 't',
      workflowName: 'research',
      workflowVersion: null,
      params: {},
      startedAt: '2026-11-09T12:00:00.000Z',
      status: 'running',
      ...fields,
    }),
  );
}

function appendEvents(runDir: string, events: readonly RunEventType[]): void {
  const log = RunEventLog.open({ runDir, runId: 'r', sync: () => undefined });
  for (const event of events) log.append(event);
  log.close();
}

function lines(
  runDir: string,
): { seq: number; event: { kind: string } & Record<string, unknown> }[] {
  const path = join(runDir, RUN_EVENTS_FILENAME);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map(
      (line) =>
        JSON.parse(line) as { seq: number; event: { kind: string } & Record<string, unknown> },
    );
}

function outcomes(runDir: string) {
  return lines(runDir).filter((line) => line.event.kind === 'run_outcome');
}

function manifest(runDir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(runDir, 'manifest.json'), 'utf8')) as Record<string, unknown>;
}

function runtimeLines(runDir: string): Record<string, unknown>[] {
  const path = join(runDir, 'runtime.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** A run whose owner (OWNER) claimed it at `epochSeq` and wrote `events`. */
async function deadOwnerRun(
  options: {
    events?: readonly RunEventType[];
    epochEvents?: readonly RunEventType[];
    manifest?: Record<string, unknown>;
  } = {},
): Promise<string> {
  const runDir = makeTempDir();
  appendEvents(runDir, options.epochEvents ?? []);
  const epoch = (options.epochEvents ?? []).length;
  await claimLease(runDir, claimInit({ logSeqAtClaim: epoch }), { identity: OWNER });
  writeManifest(runDir, options.manifest);
  appendEvents(runDir, options.events ?? [taskStarted(), assistantText('working')]);
  return runDir;
}

function deps(overrides: Partial<ReconcileDeps> & { probe?: TableProbe } = {}): ReconcileDeps & {
  readonly terminated: number[];
} {
  const terminated: number[] = [];
  return {
    trigger: 'list',
    probe: new TableProbe(),
    terminator: {
      terminate: (pid: number) => {
        terminated.push(pid);
        return Promise.resolve();
      },
    },
    clock: () => NOW,
    sleep: () => Promise.resolve(),
    ...overrides,
    terminated,
  };
}

/** Every file and its bytes, for "changed nothing" assertions. */
function snapshotDir(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    out[name] = statSync(path).isDirectory() ? '<dir>' : readFileSync(path, 'base64');
  }
  return out;
}

describe('@no-llm reconcileRun: a dead owner', () => {
  it('appends exactly one owner_lost outcome, marks the manifest interrupted and failed, and removes the lease', async () => {
    const runDir = await deadOwnerRun();
    const result = await reconcileRun(runDir, deps());
    expect(result).toEqual({
      kind: 'reconciled',
      outcome: 'failed',
      evidence: 'owner_lost',
      reaped: 0,
      uncertain: 0,
    });
    expect(outcomes(runDir)).toHaveLength(1);
    expect(outcomes(runDir)[0]?.event).toMatchObject({
      task_outcome: 'failed',
      termination_reason: 'owner_lost',
      exit_code: 2,
      failure_class: 'unexpected',
    });
    expect(manifest(runDir)).toMatchObject({
      status: 'failed',
      taskOutcome: 'failed',
      terminationReason: 'owner_lost',
      executionState: 'interrupted',
      // The last event the owner wrote, not the reconcile time.
      endedAt: AT,
    });
    expect(existsSync(join(runDir, RUN_LEASE_FILENAME))).toBe(false);
    expect(runtimeLines(runDir)).toEqual([
      {
        schema_version: 1,
        event: 'reconciled',
        by: 'list',
        evidence: 'owner_lost',
        reaped: 0,
        uncertain: 0,
        at: NOW.toISOString(),
      },
    ]);
  });

  it('reports partial when a result was persisted', async () => {
    const runDir = await deadOwnerRun();
    writeFileSync(join(runDir, 'brief.json'), '{"title":"x"}');
    const result = await reconcileRun(runDir, deps());
    expect(result).toMatchObject({ outcome: 'partial', evidence: 'owner_lost' });
    expect(manifest(runDir)).toMatchObject({ status: 'failed', taskOutcome: 'partial' });
  });

  it('keeps every manifest field it does not own (an ask-shaped manifest)', async () => {
    const runDir = await deadOwnerRun({
      manifest: { query: 'compare grinders', providerName: 'duckduckgo', fetched: 3 },
    });
    await reconcileRun(runDir, deps());
    expect(manifest(runDir)).toMatchObject({
      query: 'compare grinders',
      providerName: 'duckduckgo',
      fetched: 3,
      executionState: 'interrupted',
    });
  });

  it('writes a minimal manifest when the owner died before writing one', async () => {
    const runDir = makeTempDir();
    await claimLease(runDir, claimInit({ command: ['do'] }), { identity: OWNER });
    await reconcileRun(runDir, deps());
    expect(manifest(runDir)).toMatchObject({
      workflowName: 'do',
      runKind: 'agentic',
      status: 'failed',
      executionState: 'interrupted',
    });
  });
});

describe('@no-llm reconcileRun: concurrency and crashes', () => {
  it('gives 8 simultaneous reconcilers exactly one terminal event and one reconciled line', async () => {
    const runDir = await deadOwnerRun();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => reconcileRun(runDir, deps())),
    );
    expect(outcomes(runDir)).toHaveLength(1);
    expect(runtimeLines(runDir)).toHaveLength(1);
    expect(results.filter((result) => result.kind === 'reconciled')).toHaveLength(1);
    for (const result of results.filter((entry) => entry.kind !== 'reconciled')) {
      expect(['busy', 'no_lease']).toContain(result.kind);
    }
  });

  it('completes the remaining steps without a second event after a crash after step 3', async () => {
    const runDir = await deadOwnerRun();
    await expect(
      reconcileRun(
        runDir,
        deps({
          afterStep: (step) => {
            if (step === 3) throw new Error('crash');
          },
        }),
      ),
    ).rejects.toThrow('crash');
    expect(outcomes(runDir)).toHaveLength(1);
    expect(manifest(runDir).status).toBe('running');
    const again = await reconcileRun(runDir, deps());
    expect(again).toMatchObject({ kind: 'reconciled', evidence: 'owner_lost' });
    expect(outcomes(runDir)).toHaveLength(1);
    expect(manifest(runDir)).toMatchObject({ executionState: 'interrupted', status: 'failed' });
    expect(existsSync(join(runDir, RUN_LEASE_FILENAME))).toBe(false);
  });

  it('mirrors a terminal manifest that has no terminal event', async () => {
    const runDir = await deadOwnerRun({
      manifest: {
        status: 'completed',
        taskOutcome: 'fulfilled',
        endedAt: '2026-11-09T12:30:00.000Z',
      },
    });
    const result = await reconcileRun(runDir, deps());
    expect(result).toMatchObject({
      kind: 'reconciled',
      evidence: 'manifest',
      outcome: 'fulfilled',
    });
    expect(outcomes(runDir)[0]?.event).toMatchObject({
      task_outcome: 'fulfilled',
      exit_code: 0,
      failure_class: null,
      at: '2026-11-09T12:30:00.000Z',
    });
    expect(manifest(runDir)).not.toHaveProperty('executionState');
  });

  it('completes by evidence when the terminal event exists and the manifest still says running', async () => {
    const runDir = await deadOwnerRun({ events: [taskStarted(), runOutcome(0)] });
    const result = await reconcileRun(runDir, deps());
    expect(result).toMatchObject({
      kind: 'completed_by_evidence',
      evidence: 'event',
      outcome: 'fulfilled',
    });
    expect(outcomes(runDir)).toHaveLength(1);
    expect(manifest(runDir)).toMatchObject({ status: 'completed', taskOutcome: 'fulfilled' });
    expect(manifest(runDir)).not.toHaveProperty('executionState');
  });

  it('truncates a partial tail before appending, continuing seq from the last valid line', async () => {
    const runDir = await deadOwnerRun();
    appendFileSync(join(runDir, RUN_EVENTS_FILENAME), '{"schema_version":"1","seq":3,"ev');
    await reconcileRun(runDir, deps());
    expect(lines(runDir).map((line) => line.seq)).toEqual([1, 2, 3]);
    expect(lines(runDir).at(-1)?.event.kind).toBe('run_outcome');
  });
});

describe('@no-llm reconcileRun: verdicts and browsers', () => {
  it('reconciles a reused PID (token mismatch reads dead) without ever signalling it', async () => {
    const runDir = await deadOwnerRun();
    const probe = new TableProbe({ [`${OWNER.pid}:${OWNER.startToken}`]: 'dead' });
    const used = deps({ probe });
    await reconcileRun(runDir, used);
    expect(used.terminated).not.toContain(OWNER.pid);
    expect(outcomes(runDir)).toHaveLength(1);
  });

  it('never signals an uncertain browser, keeps the lease for it, and a second run adds no event', async () => {
    const runDir = await deadOwnerRun();
    await new FileBrowserOwnershipRecorder(runDir).recordSpawned(BROWSER);
    const probe = new TableProbe({ [`${BROWSER.pid}:${BROWSER.startToken}`]: 'unknown' });
    const first = deps({ probe });
    expect(await reconcileRun(runDir, first)).toMatchObject({ reaped: 0, uncertain: 1 });
    expect(first.terminated).toEqual([]);
    expect(existsSync(join(runDir, RUN_LEASE_FILENAME))).toBe(true);
    expect(await readOwnedBrowsers(runDir)).toEqual([BROWSER]);
    const before = readFileSync(join(runDir, RUN_EVENTS_FILENAME), 'utf8');
    expect(await reconcileRun(runDir, deps({ probe }))).toMatchObject({
      kind: 'reconciled',
      uncertain: 1,
    });
    expect(readFileSync(join(runDir, RUN_EVENTS_FILENAME), 'utf8')).toBe(before);
  });

  it('terminates a live owned browser, confirms it dead, then removes the lease', async () => {
    const runDir = await deadOwnerRun();
    await new FileBrowserOwnershipRecorder(runDir).recordSpawned(BROWSER);
    const probe = new TableProbe({ [`${BROWSER.pid}:${BROWSER.startToken}`]: 'alive' });
    const used = deps({
      probe,
      terminator: {
        terminate: (pid) => {
          used.terminated.push(pid);
          probe.set(BROWSER, 'dead');
          return Promise.resolve();
        },
      },
    });
    expect(await reconcileRun(runDir, used)).toMatchObject({ reaped: 1, uncertain: 0 });
    expect(used.terminated).toEqual([BROWSER.pid]);
    expect(existsSync(join(runDir, RUN_LEASE_FILENAME))).toBe(false);
  });

  it('keeps a live browser it could not confirm dead', async () => {
    const runDir = await deadOwnerRun();
    await new FileBrowserOwnershipRecorder(runDir).recordSpawned(BROWSER);
    const probe = new TableProbe({ [`${BROWSER.pid}:${BROWSER.startToken}`]: 'alive' });
    const { REAP_CONFIRM_MS } = await import('../../src/run-ownership/constants.js');
    let now = 0;
    const realNow = Date.now;
    Date.now = () => now;
    try {
      const result = await reconcileRun(
        runDir,
        deps({
          probe,
          sleep: () => {
            now += REAP_CONFIRM_MS;
            return Promise.resolve();
          },
        }),
      );
      expect(result).toMatchObject({ reaped: 0, uncertain: 1 });
    } finally {
      Date.now = realNow;
    }
    expect(existsSync(join(runDir, RUN_LEASE_FILENAME))).toBe(true);
  });

  it.each(['alive', 'unknown'] as const)(
    'changes nothing for an owner that is %s',
    async (verdict) => {
      const runDir = await deadOwnerRun();
      const before = snapshotDir(runDir);
      const result = await reconcileRun(
        runDir,
        deps({ probe: new TableProbe({ [`${OWNER.pid}:${OWNER.startToken}`]: verdict }) }),
      );
      expect(result).toEqual({
        kind: verdict === 'alive' ? 'owner_alive' : 'owner_unknown',
        pid: OWNER.pid,
      });
      expect(snapshotDir(runDir)).toEqual(before);
    },
  );
});

describe('@no-llm reconcileRun: epochs and legacy runs', () => {
  it('ends a dead resumed owner with a new owner_lost outcome above the earlier one', async () => {
    const runDir = await deadOwnerRun({
      epochEvents: [taskStarted(), runOutcome(2)],
      events: [
        {
          kind: 'task_resumed',
          task_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
          at: '2026-11-01T12:00:00.000Z',
          original_run_id: 'r',
          resume_step_id: 's1',
        } as RunEventType,
        assistantText('again'),
      ],
    });
    const result = await reconcileRun(runDir, deps());
    expect(result).toMatchObject({ kind: 'reconciled', evidence: 'owner_lost' });
    expect(outcomes(runDir).map((line) => line.event.termination_reason)).toEqual([
      null,
      'owner_lost',
    ]);
  });

  it('reconciles a legacy .lock whose PID is gone', async () => {
    const runDir = makeTempDir();
    writeManifest(runDir);
    appendEvents(runDir, [taskStarted()]);
    writeFileSync(join(runDir, LEGACY_LOCK_FILENAME), JSON.stringify({ pid: 0x3ffffff0 }));
    expect(await reconcileRun(runDir, deps())).toMatchObject({ kind: 'reconciled' });
    expect(existsSync(join(runDir, LEGACY_LOCK_FILENAME))).toBe(false);
    expect(manifest(runDir)).toMatchObject({ executionState: 'interrupted' });
  });

  it('treats a legacy .lock with a live PID as unverifiable', async () => {
    const runDir = makeTempDir();
    writeManifest(runDir);
    writeFileSync(join(runDir, LEGACY_LOCK_FILENAME), JSON.stringify({ pid: process.pid }));
    expect(await reconcileRun(runDir, deps())).toEqual({ kind: 'owner_unknown', pid: process.pid });
  });

  it('reconciles a running manifest with neither a lease nor a .lock', async () => {
    const runDir = makeTempDir();
    writeManifest(runDir);
    expect(await reconcileRun(runDir, deps())).toMatchObject({
      kind: 'reconciled',
      evidence: 'owner_lost',
    });
  });

  it('leaves a finished run without a lease alone', async () => {
    const runDir = makeTempDir();
    writeManifest(runDir, { status: 'completed', taskOutcome: 'fulfilled' });
    expect(await reconcileRun(runDir, deps())).toEqual({ kind: 'no_lease' });
  });

  it('reads a corrupt lease as an unverifiable owner', async () => {
    const runDir = makeTempDir();
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, RUN_LEASE_FILENAME), '{');
    expect(await reconcileRun(runDir, deps())).toEqual({ kind: 'owner_unknown', pid: null });
  });
});

describe('@no-llm reconcileRun: never aborted', () => {
  it('ends an owner_lost run as partial or failed for any evidence', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          events: fc.array(
            fc.oneof(
              fc.constant(assistantText('x')),
              fc.constantFrom('brief', 'report', 'output', 'screenshot', 'result', 'other').map(
                (kind) =>
                  ({
                    kind: 'artifact_saved',
                    path: 'x',
                    artifact_kind: kind,
                    media_type: 'application/json',
                    bytes: 1,
                    at: '2026-11-01T12:00:00.000Z',
                  }) as RunEventType,
              ),
            ),
            { maxLength: 6 },
          ),
          brief: fc.boolean(),
        }),
        async ({ events, brief }) => {
          const runDir = await deadOwnerRun({ events });
          if (brief) writeFileSync(join(runDir, 'brief.json'), '{}');
          const result = await reconcileRun(runDir, deps());
          expect(result.kind).toBe('reconciled');
          const outcome = (result as { outcome: string }).outcome;
          expect(['partial', 'failed']).toContain(outcome);
          expect(outcomes(runDir).every((line) => line.event.task_outcome !== 'aborted')).toBe(
            true,
          );
        },
      ),
      { numRuns: 25 },
    );
  }, 60_000);
});
