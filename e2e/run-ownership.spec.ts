// @no-llm
/**
 * FEAT-064 acceptance, with real processes and real sockets against the built
 * packages: killed runs reconcile to exactly one ending, identity checks never
 * signal the wrong process, run-socket clients see every event exactly once,
 * a stalled client is dropped alone, unauthenticated peers get nothing,
 * previous-version owners are left alone, stops follow the policy, and a
 * detached worker outlives its parent.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import {
  FileBrowserOwnershipRecorder,
  RunChannelClient,
  claimLease,
  encodeJsonFrame,
  listPossibleOrphans,
  processExists,
  readLease,
  resetPathCache,
  runsRoot,
  stopRun,
  type ChannelEventDelivery,
  type ProcessIdentity,
} from '@yantra/core';
import { WorkerResult, generateUlid } from '@yantra/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const run = promisify(execFile);
const FIXTURES = resolve(import.meta.dirname, 'fixtures', 'run-ownership');
const CLI_DIST = resolve(import.meta.dirname, '..', 'apps', 'cli', 'dist');
const CLI_BIN = join(CLI_DIST, 'bin.js');
const SOCKET_STUB = { kind: 'pipe', address: `\\\\.\\pipe\\yantra-${'ef'.repeat(16)}` } as const;
const GONE: ProcessIdentity = { pid: 0x3ffffff0, startToken: 'test:gone' };

const silent = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

let home: string;
let env: NodeJS.ProcessEnv;
const children: ChildProcess[] = [];
const strayPids: number[] = [];

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'yo-'));
  env = { ...process.env, YANTRA_HOME: home, LLM_PROVIDER: '' };
  vi.stubEnv('YANTRA_HOME', home);
  vi.stubEnv('LLM_PROVIDER', '');
  resetPathCache();
});

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  for (const pid of strayPids.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  resetPathCache();
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** A fixture process whose stdout is JSON lines. */
interface Fixture {
  readonly child: ChildProcess;
  readonly lines: Record<string, unknown>[];
  readonly exited: Promise<number | null>;
  waitFor(
    predicate: (line: Record<string, unknown>) => boolean,
    timeoutMs?: number,
  ): Promise<Record<string, unknown>>;
}

function startNode(
  script: string,
  args: readonly string[],
  extraEnv: NodeJS.ProcessEnv = {},
): Fixture {
  const child = spawn(process.execPath, [script, ...args], {
    env: { ...env, ...extraEnv },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  children.push(child);
  const lines: Record<string, unknown>[] = [];
  let carry = '';
  const waiters: {
    test: (line: Record<string, unknown>) => boolean;
    resolve: (line: Record<string, unknown>) => void;
  }[] = [];
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    const parts = (carry + chunk).split('\n');
    carry = parts.pop() ?? '';
    for (const part of parts) {
      if (part.trim().length === 0) continue;
      let line: Record<string, unknown>;
      try {
        line = JSON.parse(part) as Record<string, unknown>;
      } catch {
        continue;
      }
      lines.push(line);
      for (const waiter of waiters.splice(0)) {
        if (waiter.test(line)) waiter.resolve(line);
        else waiters.push(waiter);
      }
    }
  });
  const exited = new Promise<number | null>((done) => child.once('exit', (code) => done(code)));
  return {
    child,
    lines,
    exited,
    waitFor: (test, timeoutMs = 30_000) => {
      const found = lines.find(test);
      if (found !== undefined) return Promise.resolve(found);
      return new Promise((done, fail) => {
        const timer = setTimeout(() => fail(new Error('fixture line timed out')), timeoutMs);
        waiters.push({
          test,
          resolve: (line) => {
            clearTimeout(timer);
            done(line);
          },
        });
      });
    },
  };
}

function fakeOwner(config: Record<string, unknown>): Fixture {
  return startNode(join(FIXTURES, 'fake-owner.mjs'), [JSON.stringify(config)]);
}

async function runDirFor(runId: string): Promise<string> {
  const runDir = join(runsRoot(), runId);
  await mkdir(runDir, { recursive: true });
  return runDir;
}

/** Kills one process hard, never its children (`taskkill /F` without `/T`, or SIGKILL). */
async function hardKill(pid: number): Promise<void> {
  if (process.platform === 'win32')
    await run('taskkill', ['/F', '/PID', String(pid)]).catch(() => undefined);
  else process.kill(pid, 'SIGKILL');
}

function sleeper(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  children.push(child);
  return child;
}

async function until(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const started = Date.now();
  while (!(await predicate())) {
    if (Date.now() - started > timeoutMs) throw new Error('until: timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

function eventLines(runDir: string): { seq: number; event: Record<string, unknown> }[] {
  const path = join(runDir, 'run-events.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.endsWith('}'))
    .map((line) => JSON.parse(line) as { seq: number; event: Record<string, unknown> });
}

function manifestOf(runDir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(runDir, 'manifest.json'), 'utf8')) as Record<string, unknown>;
}

async function yantraList(): Promise<{ items: Record<string, unknown>[] }> {
  const { stdout } = await run(process.execPath, [CLI_BIN, 'list', 'runs', '--json'], { env });
  return JSON.parse(stdout) as { items: Record<string, unknown>[] };
}

function client(runDir: string): { client: RunChannelClient; seen: ChannelEventDelivery[] } {
  const created = new RunChannelClient({ clientKind: 'test', runDir, logger: silent });
  const seen: ChannelEventDelivery[] = [];
  created.onEvent((delivery) => seen.push(delivery));
  return { client: created, seen };
}

async function attach(runDir: string, from = 1) {
  const read = await readLease(runDir);
  if (read.kind !== 'lease') throw new Error(`no lease (${read.kind})`);
  const made = client(runDir);
  expect((await made.client.connect(read.lease)).state).toBe('attached');
  made.client.subscribe(from);
  return made;
}

function expectExactlyOnce(seen: readonly ChannelEventDelivery[], runDir: string): void {
  const seqs = seen.map((delivery) => delivery.seq);
  expect(seqs).toEqual(eventLines(runDir).map((line) => line.seq));
  expect(new Set(seqs).size).toBe(seqs.length);
}

describe('@no-llm run ownership: killed runs', () => {
  it('reconciles a hard-killed research run to exactly one owner_lost ending, reaping its browser by identity', async () => {
    const owner = startNode(join(FIXTURES, 'research-owner.mjs'), []);
    const { runDir } = (await owner.waitFor((line) => 'runDir' in line)) as { runDir: string };
    const { browser } = (await owner.waitFor((line) => 'browser' in line)) as { browser: number };
    strayPids.push(browser);
    expect(existsSync(join(runDir, 'lease.json'))).toBe(true);
    await hardKill(owner.child.pid ?? 0);
    await owner.exited;
    expect(processExists(browser)).toBe(true); // orphaned, not killed with its owner

    const lists = await Promise.all([yantraList(), yantraList(), yantraList()]);
    const outcomes = eventLines(runDir).filter((line) => line.event.kind === 'run_outcome');
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.event).toMatchObject({ termination_reason: 'owner_lost' });
    expect(manifestOf(runDir)).toMatchObject({ executionState: 'interrupted', status: 'failed' });
    expect(existsSync(join(runDir, 'lease.json'))).toBe(false);
    await until(() => !processExists(browser), 10_000);
    for (const listed of lists) {
      for (const item of listed.items) expect(item.status).not.toBe('running');
    }
  }, 120_000);

  it('never signals a live process whose PID a forged lease reuses, and still reconciles', async () => {
    const unrelated = sleeper();
    const runDir = await runDirFor('20261110T000000Z-fixture-reused01');
    await claimLease(
      runDir,
      {
        runId: 'r',
        origin: 'terminal',
        executionClass: 'run',
        command: ['run'],
        socket: SOCKET_STUB,
        logSeqAtClaim: 0,
      },
      { identity: { pid: unrelated.pid ?? 0, startToken: 'linux:1' } },
    );
    await writeFile(
      join(runDir, 'manifest.json'),
      JSON.stringify({ runId: 'r', startedAt: new Date().toISOString(), status: 'running' }),
    );
    await yantraList();
    expect(processExists(unrelated.pid ?? 0)).toBe(true);
    expect(manifestOf(runDir)).toMatchObject({ executionState: 'interrupted' });
  }, 60_000);

  it('never signals an owned browser whose identity is unknown, and lists it as a possible orphan', async () => {
    const browser = sleeper();
    const runDir = await runDirFor('20261110T000000Z-fixture-uncert01');
    await claimLease(
      runDir,
      {
        runId: 'r',
        origin: 'terminal',
        executionClass: 'run',
        command: ['run'],
        socket: SOCKET_STUB,
        logSeqAtClaim: 0,
      },
      { identity: GONE },
    );
    await new FileBrowserOwnershipRecorder(runDir).recordSpawned({
      pid: browser.pid ?? 0,
      startToken: 'unknown',
    });
    await yantraList();
    expect(processExists(browser.pid ?? 0)).toBe(true);
    expect(existsSync(join(runDir, 'lease.json'))).toBe(true);
    const orphans = await listPossibleOrphans();
    expect(orphans.map((orphan) => orphan.browsers)).toEqual([
      [{ pid: browser.pid, startToken: 'unknown' }],
    ]);
  }, 60_000);
});

describe('@no-llm run ownership: the run socket', () => {
  it('gives a client that attaches mid-run, drops, and reattaches every event exactly once', async () => {
    const runDir = await runDirFor('20261110T000000Z-fixture-second01');
    const owner = fakeOwner({ runDir, runId: 'second', events: 2_000, intervalMs: 2 });
    await owner.waitFor((line) => line.ready === true);
    await new Promise((r) => setTimeout(r, 400));
    const { client: attached, seen } = await attach(runDir);
    await until(() => seen.length >= 300, 20_000);
    (attached as unknown as { socket: { destroy(): void } }).socket.destroy();
    await until(() => attached.getSnapshot().state === 'disconnected', 5_000);
    expect((await attached.reconnect()).state).toBe('attached');
    await owner.waitFor((line) => line.done === true, 60_000);
    await until(() => attached.getSnapshot().state === 'ended', 15_000);
    expectExactlyOnce(seen, runDir);
    expect(attached.gaps).toBe(0);
    attached.close();
  }, 120_000);

  it('drops a stalled client alone; a reading client keeps flowing and both reach parity with the file', async () => {
    const runDir = await runDirFor('20261110T000000Z-fixture-slow0001');
    const owner = fakeOwner({
      runDir,
      runId: 'slow',
      forever: true,
      intervalMs: 5,
      burst: 10,
      textBytes: 8_192,
    });
    await owner.waitFor((line) => line.ready === true);
    const slow = startNode(join(FIXTURES, 'slow-client.mjs'), [runDir]);
    await slow.waitFor((line) => line.stalled === true);
    const fast = await attach(runDir);
    await owner
      .waitFor((line) => line.log === 'channel_overflow', 20_000)
      .catch((error: unknown) => {
        throw new Error(
          `${String(error)} fast=${fast.seen.length} slow=${JSON.stringify(slow.lines)} owner=${JSON.stringify(owner.lines.slice(-5))}`,
        );
      });
    const replaying = await attach(runDir); // the dropped client, reattached from the start
    await until(() => replaying.seen.length >= fast.seen.length, 30_000);
    await hardKill(owner.child.pid ?? 0);
    await owner.exited;
    await until(() => ['disconnected', 'ended'].includes(fast.client.getSnapshot().state), 10_000);
    await new Promise((r) => setTimeout(r, 1_000)); // the file fallback finishes
    expectExactlyOnce(fast.seen, runDir);
    expectExactlyOnce(replaying.seen, runDir);
    fast.client.close();
    replaying.client.close();
  }, 120_000);

  it('sends nothing to a peer that never authenticates or presents a wrong token', async () => {
    const runDir = await runDirFor('20261110T000000Z-fixture-noauth01');
    const owner = fakeOwner({ runDir, runId: 'noauth', forever: true, intervalMs: 20 });
    await owner.waitFor((line) => line.ready === true);
    const read = await readLease(runDir);
    if (read.kind !== 'lease') throw new Error('no lease');
    const probe = async (frame: Buffer | null): Promise<number> => {
      const socket = connect(read.lease.socket.address);
      let bytes = 0;
      socket.on('data', (chunk: Buffer) => (bytes += chunk.length));
      socket.on('error', () => undefined);
      await new Promise((r) => socket.once('connect', r));
      if (frame !== null) socket.write(frame);
      await new Promise((r) => socket.once('close', r));
      return bytes;
    };
    const wrong = encodeJsonFrame({
      type: 'hello',
      token: 'x'.repeat(43),
      channel_version: 1,
      capabilities: ['events'],
      client_kind: 'test',
    });
    expect(await Promise.all([probe(wrong), probe(null)])).toEqual([0, 0]);
  }, 30_000);

  it('reports a previous-version owner as live_unavailable, sends it nothing, and leaves it to exit 0', async () => {
    const runDir = await runDirFor('20261110T000000Z-fixture-v0000001');
    const owner = startNode(join(FIXTURES, 'channel-v0-server.mjs'), [
      JSON.stringify({ runDir, runId: 'v0', lifetimeMs: 3_000 }),
    ]);
    await owner.waitFor((line) => line.ready === true);
    const read = await readLease(runDir);
    if (read.kind !== 'lease') throw new Error('no lease');
    const { client: attaching } = client(runDir);
    expect(await attaching.connect(read.lease)).toEqual({
      state: 'live_unavailable',
      ownerVersion: '0.0.0-v0',
    });
    expect(await attaching.cancel()).toBeNull();
    attaching.close();
    expect(await owner.exited).toBe(0);
    expect(owner.lines).toContainEqual({ framesAfterHello: 0 });
  }, 30_000);
});

describe('@no-llm run ownership: stopping runs', () => {
  it('stops an owner that honors cancel gracefully', async () => {
    const runDir = await runDirFor('20261110T000000Z-fixture-stopok01');
    const owner = fakeOwner({
      runDir,
      runId: 'stop-ok',
      forever: true,
      intervalMs: 20,
      cancel: 'honor',
    });
    await owner.waitFor((line) => line.ready === true);
    expect(await stopRun({ runDir }, { logger: silent })).toMatchObject({
      kind: 'stopped_gracefully',
    });
    expect(await owner.exited).toBe(0);
  }, 60_000);

  it('terminates an owner that acknowledges but ignores cancel after the grace period, then reconciles', async () => {
    const runDir = await runDirFor('20261110T000000Z-fixture-stopig01');
    const owner = fakeOwner({
      runDir,
      runId: 'stop-ignore',
      forever: true,
      intervalMs: 20,
      cancel: 'ignore',
    });
    await owner.waitFor((line) => line.ready === true);
    const started = Date.now();
    const result = await stopRun({ runDir }, { logger: silent });
    expect(Date.now() - started).toBeGreaterThanOrEqual(10_000);
    expect(result).toMatchObject({
      kind: 'stopped_forcefully',
      reconcile: { kind: 'reconciled', evidence: 'owner_lost' },
    });
    await owner.exited;
    expect(existsSync(join(runDir, 'lease.json'))).toBe(false);
  }, 90_000);

  it('terminates a real research run at once (honored: false) and reconciles it to owner_lost', async () => {
    const owner = startNode(join(FIXTURES, 'research-owner.mjs'), []);
    const { runDir } = (await owner.waitFor((line) => 'runDir' in line)) as { runDir: string };
    const { browser } = (await owner.waitFor((line) => 'browser' in line)) as { browser: number };
    strayPids.push(browser);
    const started = Date.now();
    const result = await stopRun({ runDir }, { logger: silent });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result).toMatchObject({
      kind: 'stopped_forcefully',
      reconcile: { kind: 'reconciled', evidence: 'owner_lost' },
    });
    await owner.exited;
    expect(manifestOf(runDir)).toMatchObject({ executionState: 'interrupted' });
  }, 90_000);
});

describe('@no-llm run ownership: detached workers', () => {
  it('runs research to completion after the spawning parent exits, with a matching exit code', async () => {
    const launchDir = join(home, 'launch');
    const id = generateUlid();
    const launch = {
      schema_version: 1,
      invocation: {
        invocation_id: id,
        path: ['research'],
        argv: [
          '--no-llm',
          '--pipeline-timeout',
          '15s',
          '--max-sources',
          '2',
          'worker survival check',
        ],
        cwd: home,
      },
      result_path: join(launchDir, `${id}.result.json`),
    };
    const parent = join(home, 'parent.mjs');
    await writeFile(
      parent,
      [
        `import { spawnDetachedWorker } from ${JSON.stringify(pathToFileURL(join(CLI_DIST, 'worker', 'spawn.js')).href)};`,
        `const spawned = await spawnDetachedWorker({ launch: JSON.parse(process.argv[2]), launchDir: process.argv[3], env: process.env });`,
        `process.stdout.write(JSON.stringify({ worker: spawned.pid }) + '\\n');`,
        `process.exit(0);`,
      ].join('\n'),
    );
    const spawner = startNode(parent, [JSON.stringify(launch), launchDir], {
      YANTRA_WORKER_LAUNCH_DIR: launchDir,
    });
    const { worker } = (await spawner.waitFor((line) => 'worker' in line)) as { worker: number };
    strayPids.push(worker);
    expect(await spawner.exited).toBe(0);
    await until(() => existsSync(launch.result_path), 120_000);
    const result = WorkerResult.parse(JSON.parse(readFileSync(launch.result_path, 'utf8')));
    const runIds = readdirSync(runsRoot());
    expect(runIds).toHaveLength(1);
    const outcome = eventLines(join(runsRoot(), runIds[0] ?? '')).find(
      (line) => line.event.kind === 'run_outcome',
    );
    expect(outcome?.event.exit_code).toBe(result.outcome.exit_code);
  }, 180_000);
});
