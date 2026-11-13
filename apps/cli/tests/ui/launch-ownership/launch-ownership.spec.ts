// @no-llm
/**
 * Launch-ownership evidence (FEAT-065 TASK-019, plan §10 B1).
 *
 * A real host process (the compiled runtime) and real detached workers (the
 * FEAT-064 worker entry with the real claim), driven over the real app
 * channel, with the host killed at each dangerous point. Every case asserts:
 *
 * - each invocation executed at most once (one marker), exactly once when it
 *   finished, never when it ended `never_started`;
 * - at most two `run` invocations were reserved-or-running at every
 *   observation;
 * - every invocation ends in `finished`, `never_started` or `start_unknown`.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { FileInvocationStore, resetPathCache } from '@yantra/core';
import { HostLockRecord, generateUlid, type InvocationRecord } from '@yantra/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ControlClient } from '../../../src/ui/host/control-socket.js';
import { connectAuthenticated, type TestSocket } from '../host/rpc-support.js';
import { cleanupTempDirs, makeWebBuild } from '../host/support.js';
import { exchange, requireBuiltCli } from '../security/support.js';

const HOST = resolve(import.meta.dirname, 'fixtures', 'fixture-host.mjs');
const TERMINAL = new Set(['finished', 'never_started', 'start_unknown']);
const ACTIVE = new Set(['reserved', 'spawning', 'claimed', 'running']);

let home: string;
let previousHome: string | undefined;
let markers: string;
let web: string;
let store: FileInvocationStore;
let hosts: ChildProcess[];
let maxActive: number;
let observer: NodeJS.Timeout | null;

interface Started {
  readonly child: ChildProcess;
  readonly port: number;
  readonly exited: Promise<number | null>;
}

function startHost(fault = ''): Promise<Started> {
  const child = spawn(process.execPath, [HOST], {
    env: {
      ...process.env,
      YANTRA_HOME: home,
      YANTRA_UI_ASSETS_DIR: web,
      YANTRA_TEST_FAULT: fault,
      YANTRA_TEST_MARKERS: markers,
      LLM_PROVIDER: 'none',
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  hosts.push(child);
  const exited = new Promise<number | null>((done) => child.once('exit', (code) => done(code)));
  return new Promise((resolveReady, reject) => {
    let buffer = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      for (const line of buffer.split('\n').slice(0, -1)) {
        const parsed = JSON.parse(line) as { ready?: boolean; port?: number; worker?: number };
        if (parsed.worker !== undefined) workers.push(parsed.worker);
        if (parsed.ready === true && parsed.port !== undefined)
          resolveReady({ child, port: parsed.port, exited });
      }
      buffer = buffer.slice(buffer.lastIndexOf('\n') + 1);
    });
    void exited.then((code) => reject(new Error(`host exited before ready (${String(code)})`)));
  });
}

async function window(port: number): Promise<TestSocket> {
  const lock = HostLockRecord.parse(
    JSON.parse(readFileSync(join(home, 'data', 'ui', 'host.lock'), 'utf8')),
  );
  const control = await ControlClient.connect(lock.control_socket!, lock.control_token);
  const { code } = await control.issueLaunchCode();
  control.close();
  const { cookie, capability } = await exchange(port, code);
  return connectAuthenticated(port, cookie!, capability!);
}

function invoke(socket: TestSocket, id: string, path: string[], argv: string[]) {
  const requestId = `invoke-${id}-${Math.random()}`;
  socket.send({
    jsonrpc: '2.0',
    method: 'command.invoke',
    params: {
      invocation: { invocation_id: id, path, argv, cwd: home },
      displayed_effective: { settings: [], content: [] },
    },
    id: requestId,
  });
  // Spawning goes through a trampoline; under full-suite load that is slow.
  return socket.reply(requestId, 30_000);
}

/** Every worker this test's hosts started (from their `{"worker": pid}` lines). */
const workers: number[] = [];

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function markersFor(id: string): string[] {
  return readdirSync(markers).filter((name) => name.startsWith(`${id}.`));
}

async function settled(ids: readonly string[], timeoutMs = 30_000): Promise<InvocationRecord[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const records = (await Promise.all(ids.map((id) => store.get(id)))).filter(
      (record): record is InvocationRecord => record !== null,
    );
    if (records.length === ids.length && records.every((record) => TERMINAL.has(record.state))) {
      return records;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `not settled: ${records.map((r) => `${r.invocation_id}=${r.state}`).join(', ')}`,
      );
    }
    await new Promise((done) => setTimeout(done, 100));
  }
}

function assertOwnership(records: readonly InvocationRecord[]): void {
  for (const record of records) {
    const count = markersFor(record.invocation_id).length;
    expect({ id: record.invocation_id, count: Math.min(count, 2) }).toEqual({
      id: record.invocation_id,
      count: Math.min(count, 1),
    });
    // A successful finish executed exactly once; a busy or lost owner may not have.
    if (record.state === 'finished' && record.result?.exit_code === 0) expect(count).toBe(1);
    if (record.state === 'never_started') expect(count).toBe(0);
  }
  expect(maxActive).toBeLessThanOrEqual(2);
}

beforeEach(() => {
  requireBuiltCli();
  previousHome = process.env.YANTRA_HOME;
  home = mkdtempSync(join(tmpdir(), 'yantra-ownership-'));
  process.env.YANTRA_HOME = home;
  resetPathCache();
  markers = join(home, 'markers');
  mkdirSync(markers);
  web = makeWebBuild();
  store = new FileInvocationStore();
  hosts = [];
  maxActive = 0;
  observer = setInterval(() => {
    void store.list().then((records) => {
      const active = records.filter(
        (r) => r.execution_class === 'run' && ACTIVE.has(r.state),
      ).length;
      maxActive = Math.max(maxActive, active);
    });
  }, 25);
});

afterEach(async () => {
  if (observer !== null) clearInterval(observer);
  for (const host of hosts) host.kill();
  // Detached workers outlive their host by design; let them finish before cleanup.
  for (let i = 0; i < 100 && workers.some(alive); i++) {
    await new Promise((done) => setTimeout(done, 100));
  }
  workers.length = 0;
  if (previousHome === undefined) delete process.env.YANTRA_HOME;
  else process.env.YANTRA_HOME = previousHome;
  resetPathCache();
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  cleanupTempDirs();
}, 30_000);

describe('@no-llm launch ownership', () => {
  it('runs simultaneous submissions once each, never more than two at a time', async () => {
    const host = await startHost();
    const socket = await window(host.port);
    const ids = Array.from({ length: 5 }, () => generateUlid());
    await Promise.all(ids.map((id) => invoke(socket, id, ['research'], ['--no-llm', id])));
    const records = await settled(ids);
    expect(records.every((record) => record.state === 'finished')).toBe(true);
    assertOwnership(records);
    socket.ws.close();
  }, 60_000);

  it('never launches twice when a lost response is retried with the same ID', async () => {
    const host = await startHost();
    const socket = await window(host.port);
    const id = generateUlid();
    const first = invoke(socket, id, ['research'], ['--no-llm', 'q']);
    const retry = invoke(socket, id, ['research'], ['--no-llm', 'q']);
    await Promise.all([first, retry]);
    await invoke(socket, id, ['research'], ['--no-llm', 'q']);
    const records = await settled([id]);
    expect(markersFor(id)).toHaveLength(1);
    assertOwnership(records);
    socket.ws.close();
  }, 60_000);

  it.each([
    ['before the spawn', 'host:before-spawn', ['never_started']],
    [
      'after the spawn, before the claim',
      'host:after-spawn worker:delay-claim',
      ['never_started', 'finished'],
    ],
    ['after the claim, before the lease', 'host:after-claim worker:delay-lease', ['finished']],
    ['after completion, before the response', 'host:after-complete', ['finished']],
  ])(
    'survives a host killed %s',
    async (_label, fault, allowed) => {
      // Arrange: a host that dies at the fault point.
      const doomed = await startHost(fault);
      const socket = await window(doomed.port);
      const id = generateUlid();

      // Act: the invocation is submitted; the host dies; a new host starts and recovers.
      void invoke(socket, id, ['research'], ['--no-llm', 'q']).catch(() => undefined);
      await doomed.exited;
      await startHost();

      // Assert
      const records = await settled([id]);
      expect(allowed).toContain(records[0]?.state);
      assertOwnership(records);
    },
    60_000,
  );

  it('lets exactly one of two concurrent resumes of one run own it; the other ends busy', async () => {
    const host = await startHost();
    const socket = await window(host.port);
    const runId = '20261111T100000Z-research-0000beef';
    mkdirSync(join(home, 'data', 'runs', runId), { recursive: true });
    const ids = [generateUlid(), generateUlid()];
    await Promise.all(ids.map((id) => invoke(socket, id, ['resume'], [runId])));
    const records = await settled(ids);
    const ran = ids.filter((id) => markersFor(id).length === 1);
    expect(ran).toHaveLength(1);
    const loser = records.find((record) => record.invocation_id !== ran[0]);
    expect(loser?.result?.exit_code).toBe(3);
    expect(records.every((record) => record.run_id === runId)).toBe(true);
    assertOwnership(records);
    socket.ws.close();
  }, 60_000);
});
