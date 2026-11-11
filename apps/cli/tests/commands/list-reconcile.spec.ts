// @no-llm
/**
 * `yantra list` ends runs whose owner died before listing them (FEAT-064
 * TASK-010), in a sandboxed YANTRA_HOME.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { claimLease, identifyProcess, resetPathCache, runsRoot } from '@yantra/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeListCommand } from '../../src/commands/list.js';
import { RUN_START_SWEEP_BUDGET_MS, startRunStartSweep } from '../../src/ownership.js';

const SOCKET = { kind: 'pipe', address: `\\\\.\\pipe\\yantra-${'ab'.repeat(16)}` } as const;

describe('@no-llm yantra list reconciles dead owners', () => {
  let root: string;
  let saved: string | undefined;
  let stdout: string[];
  const children: ChildProcess[] = [];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'yantra-list-reconcile-'));
    saved = process.env.YANTRA_HOME;
    process.env.YANTRA_HOME = root;
    resetPathCache();
    stdout = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      stdout.push(String(chunk));
      return true;
    }) as never);
    vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const child of children.splice(0)) child.kill();
    if (saved === undefined) delete process.env.YANTRA_HOME;
    else process.env.YANTRA_HOME = saved;
    resetPathCache();
    await rm(root, { recursive: true, force: true });
  });

  async function run(args: readonly string[]): Promise<string> {
    stdout = [];
    await makeListCommand()
      .exitOverride()
      .parseAsync([...args], { from: 'user' });
    return stdout.join('');
  }

  async function workflowRun(
    runId: string,
    owner: { pid: number; startToken: string } | null,
  ): Promise<string> {
    const runDir = join(runsRoot(), runId);
    await mkdir(runDir, { recursive: true });
    if (owner !== null) {
      await claimLease(
        runDir,
        {
          runId,
          origin: 'terminal',
          executionClass: 'run',
          command: ['run'],
          socket: SOCKET,
          logSeqAtClaim: 0,
        },
        { identity: owner },
      );
    }
    await writeFile(
      join(runDir, 'manifest.json'),
      JSON.stringify({
        runId,
        taskId: 't',
        workflowName: 'fixture',
        workflowVersion: null,
        params: {},
        startedAt: '2026-11-09T12:00:00.000Z',
        status: 'running',
        profileKind: 'ephemeral',
        cookieProfilePath: null,
        outputBindingNames: [],
      }),
    );
    return runDir;
  }

  const DEAD = { pid: 0x3ffffff0, startToken: 'test:dead' };

  it('shows a dead-owner run as interrupted, not running, in terminal and --json output', async () => {
    const runDir = await workflowRun('20261109T120000Z-fixture-dead0001', DEAD);
    const text = await run(['runs']);
    expect(text).toContain('interrupted · failed');
    expect(text).not.toMatch(/fixture-dead0001\s+running/u);
    const json = JSON.parse(await run(['runs', '--json'])) as {
      items: {
        runId: string;
        status: string;
        executionState?: string;
        taskOutcome?: string;
      }[];
    };
    expect(json.items.find((item) => item.runId.endsWith('dead0001'))).toMatchObject({
      status: 'failed',
      taskOutcome: 'failed',
      executionState: 'interrupted',
    });
    const manifest = JSON.parse(await readFile(join(runDir, 'manifest.json'), 'utf8')) as {
      executionState?: string;
    };
    expect(manifest.executionState).toBe('interrupted');
  });

  it('reconciles a legacy running manifest that has no lease', async () => {
    await workflowRun('20261109T120000Z-fixture-legacy01', null);
    const json = JSON.parse(await run(['runs', '--json'])) as {
      items: { runId: string; executionState?: string }[];
    };
    expect(json.items[0]).toMatchObject({ executionState: 'interrupted' });
  });

  it('leaves a run with a live owner running', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      stdio: 'ignore',
    });
    children.push(child);
    const identity = await identifyProcess(child.pid ?? 0);
    expect(identity).not.toBeNull();
    await workflowRun('20261109T120000Z-fixture-alive001', identity);
    const json = JSON.parse(await run(['runs', '--json'])) as {
      items: { status: string; executionState?: string }[];
    };
    expect(json.items[0]?.status).toBe('running');
    expect(json.items[0]).not.toHaveProperty('executionState');
  }, 30_000);
});

describe('@no-llm run-start sweep', () => {
  it('never holds the command past its budget', async () => {
    let now = 0;
    const waits: number[] = [];
    const sweep = startRunStartSweep({
      reconcile: () => new Promise(() => undefined), // never finishes
      now: () => now,
      wait: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });
    now = 1_200; // the run itself took 1.2 s
    await sweep.settle();
    expect(waits).toEqual([RUN_START_SWEEP_BUDGET_MS - 1_200]);
  });

  it('does not wait at all once the budget has passed', async () => {
    let now = 0;
    const waits: number[] = [];
    const sweep = startRunStartSweep({
      reconcile: () => new Promise(() => undefined),
      now: () => now,
      wait: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });
    now = 60_000;
    await sweep.settle();
    expect(waits).toEqual([0]);
  });

  it('swallows a failing sweep, reporting it only at debug', async () => {
    const debug = vi.fn();
    const sweep = startRunStartSweep({
      reconcile: () => Promise.reject(new Error('disk')),
      logger: { debug },
      wait: () => new Promise(() => undefined),
    });
    await sweep.settle();
    expect(debug).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'run_start_sweep_failed' }),
      'run_start_sweep_failed',
    );
  });

  it('starts with trigger cli and the 5 s budget', async () => {
    const reconcile = vi.fn(() =>
      Promise.resolve({ scanned: 0, reconciled: [], truncated: false }),
    );
    await startRunStartSweep({ reconcile }).settle();
    expect(reconcile).toHaveBeenCalledWith({ trigger: 'cli', budgetMs: 5_000 });
  });
});
