// @no-llm
/**
 * The supervisor (FEAT-065 TASK-015): launching once, the queue, refusals,
 * cancel and results. A fake spawner stands in for the detached worker.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ClaimRefusedError,
  FileInvocationStore,
  resetPathCache,
  type LivenessVerdict,
  type ProcessIdentity,
  type ProcessLivenessProbe,
} from '@yantra/core';
import type { CommandInvocation, WorkerLaunch } from '@yantra/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  RpcError,
  RpcMethodRegistry,
  type RpcCallContext,
} from '../../../src/ui/host/rpc-server.js';
import { Supervisor, type SupervisorDeps } from '../../../src/ui/host/supervisor.js';

const CWD = process.platform === 'win32' ? 'C:\\work' : '/work';
let counter = 0;

function invocation(path: string[], argv: string[] = []): CommandInvocation {
  counter += 1;
  return {
    invocation_id: `01JD2X7Q8R9S0T1V2W3X${String(counter).padStart(6, '0')}`,
    path,
    argv,
    cwd: CWD,
  };
}

const DISPLAYED = { settings: [], content: [] };

class MapProbe implements ProcessLivenessProbe {
  public verdict: LivenessVerdict = 'alive';
  public identify(pid: number): Promise<ProcessIdentity | null> {
    return Promise.resolve({ pid, startToken: 't' });
  }
  public check(): Promise<LivenessVerdict> {
    return Promise.resolve(this.verdict);
  }
}

let home: string;
let previousHome: string | undefined;
let store: FileInvocationStore;
let launches: WorkerLaunch[];
let notices: [string, Record<string, unknown>][];
let probe: MapProbe;
let supervisor: Supervisor;

function make(overrides: Partial<SupervisorDeps> = {}): Supervisor {
  return new Supervisor({
    store,
    launchDir: join(home, 'launch'),
    spawn: (launch) => {
      launches.push(launch);
      return Promise.resolve({
        pid: 5000 + launches.length,
        identity: { pid: 1, startToken: 'w' },
        launchPath: 'x',
      });
    },
    notify: (method, params) => notices.push([method, params]),
    probe,
    terminator: { terminate: vi.fn(() => Promise.resolve()) },
    sleep: () => Promise.resolve(),
    ...overrides,
  });
}

beforeEach(() => {
  previousHome = process.env.YANTRA_HOME;
  home = mkdtempSync(join(tmpdir(), 'yantra-supervisor-'));
  process.env.YANTRA_HOME = home;
  resetPathCache();
  store = new FileInvocationStore();
  launches = [];
  notices = [];
  probe = new MapProbe();
  supervisor = make();
});

afterEach(() => {
  supervisor.stopLoop();
  if (previousHome === undefined) delete process.env.YANTRA_HOME;
  else process.env.YANTRA_HOME = previousHome;
  resetPathCache();
  rmSync(home, { recursive: true, force: true });
});

describe('command.invoke', () => {
  it('spawns a run invocation once, as a launch with its result path', async () => {
    // Act
    const result = await supervisor.invoke(invocation(['research'], ['--no-llm', 'q']), DISPLAYED);

    // Assert
    expect(result).toMatchObject({ state: 'spawning', execution_class: 'run', path: ['research'] });
    expect(launches).toHaveLength(1);
    expect(launches[0]?.invocation.argv).toEqual(['--no-llm', 'q']);
    expect(launches[0]?.result_path).toBe(
      join(home, 'data', 'ui', 'invocations', `${result.invocation_id}.result.json`),
    );
  });

  it('queues the third run at position 1 and starts it when a slot frees', async () => {
    const [a, , c] = [
      invocation(['research'], ['a']),
      invocation(['research'], ['b']),
      invocation(['research'], ['c']),
    ];
    const first = await supervisor.invoke(a, DISPLAYED);
    await supervisor.invoke(invocation(['research'], ['b']), DISPLAYED);
    const third = await supervisor.invoke(c, DISPLAYED);
    expect(third).toMatchObject({ state: 'queued', position: 1 });
    expect(launches).toHaveLength(2);

    // The first worker claims and finishes.
    await store.claim(first.invocation_id, { pid: 1, startToken: 'w' });
    await store.finish(first.invocation_id, { exitCode: 0 });
    await supervisor.dequeue();

    expect(launches.map((launch) => launch.invocation.argv[0])).toEqual(['a', 'b', 'c']);
  });

  it('returns the same state for a repeated ID (a lost response) and never spawns twice', async () => {
    const request = invocation(['research'], ['q']);
    const first = await supervisor.invoke(request, DISPLAYED);
    const again = await supervisor.invoke(request, DISPLAYED);
    expect(again.invocation_id).toBe(first.invocation_id);
    expect(again.state).toBe(first.state);
    expect(launches).toHaveLength(1);
  });

  it('refuses a read and names the read method to use', async () => {
    const error = await supervisor
      .invoke(invocation(['list']), DISPLAYED)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RpcError);
    expect(error).toMatchObject({ code: -32003, data: { remediation: 'Use read.list.' } });
  });

  it('refuses ui (exemption) with the terminal step', async () => {
    const error = await supervisor
      .invoke(invocation(['ui']), DISPLAYED)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: -32003,
      data: { remediation: 'Run `yantra ui` in a terminal.' },
    });
  });

  it('refuses a secret command', async () => {
    const error = await supervisor
      .invoke(invocation(['secret', 'list']), DISPLAYED)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: -32003 });
  });

  it('refuses an argv that does not parse', async () => {
    const error = await supervisor
      .invoke(invocation(['research'], ['--nope']), DISPLAYED)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: -32602 });
    expect(launches).toEqual([]);
  });

  it('starts mutate invocations without taking a run slot', async () => {
    await supervisor.invoke(invocation(['research'], ['a']), DISPLAYED);
    await supervisor.invoke(invocation(['research'], ['b']), DISPLAYED);
    const mutate = await supervisor.invoke(
      invocation(['prefs'], ['set', 'ui.theme', 'dark']),
      DISPLAYED,
    );
    expect(mutate.state).toBe('spawning');
  });

  it('marks start_unknown when the spawn fails, and announces it', async () => {
    supervisor = make({ spawn: () => Promise.reject(new Error('trampoline exited')) });
    const result = await supervisor.invoke(invocation(['research'], ['q']), DISPLAYED);
    expect(result.state).toBe('start_unknown');
    expect(
      notices.some(
        ([method, params]) => method === 'invocation.changed' && params.state === 'start_unknown',
      ),
    ).toBe(true);
  });
});

describe('cancel', () => {
  it('discards a queued item', async () => {
    await supervisor.invoke(invocation(['research'], ['a']), DISPLAYED);
    await supervisor.invoke(invocation(['research'], ['b']), DISPLAYED);
    const queued = await supervisor.invoke(invocation(['research'], ['c']), DISPLAYED);
    expect((await supervisor.cancel(queued.invocation_id)).state).toBe('discarded');
  });

  it('withdraws a spawning item so the worker’s claim is refused', async () => {
    const started = await supervisor.invoke(invocation(['research'], ['q']), DISPLAYED);
    expect((await supervisor.cancel(started.invocation_id)).state).toBe('never_started');
    await expect(
      store.claim(started.invocation_id, { pid: 9, startToken: 'late' }),
    ).rejects.toBeInstanceOf(ClaimRefusedError);
  });

  it('stops a running run through stopRun with the 10 s grace, then records the lost owner', async () => {
    // Arrange: a running invocation that owns a run.
    const stop = vi.fn(() =>
      Promise.resolve({ kind: 'stopped_forcefully' as const, reconcile: { kind: 'no_lease' } }),
    );
    supervisor = make({ stop: stop as never });
    const started = await supervisor.invoke(invocation(['research'], ['q']), DISPLAYED);
    await store.claim(started.invocation_id, { pid: 77, startToken: 'w' });
    await store.markRunning(started.invocation_id, 'run-abc');
    probe.verdict = 'dead';

    // Act
    await supervisor.cancel(started.invocation_id);
    await vi.waitFor(async () => {
      expect((await store.get(started.invocation_id))?.state).toBe('finished');
    });

    // Assert
    expect(stop).toHaveBeenCalledWith(
      { runDir: join(home, 'data', 'runs', 'run-abc'), graceMs: 10_000 },
      expect.anything(),
    );
    expect((await store.get(started.invocation_id))?.result).toMatchObject({
      reason: 'owner_lost',
    });
  });

  it('terminates a socketless mutate worker by identity after the grace', async () => {
    const terminate = vi.fn(() => Promise.resolve());
    const sleep = vi.fn(() => Promise.resolve());
    supervisor = make({ terminator: { terminate }, sleep });
    const started = await supervisor.invoke(
      invocation(['prefs'], ['set', 'ui.theme', 'dark']),
      DISPLAYED,
    );
    await store.claim(started.invocation_id, { pid: 88, startToken: 'w' });
    await supervisor.cancel(started.invocation_id);
    await vi.waitFor(() => {
      expect(terminate).toHaveBeenCalledWith(88);
    });
    expect(sleep).toHaveBeenCalledWith(10_000);
  });
});

describe('queue.*', () => {
  async function call(method: string, params: unknown) {
    const methods = new RpcMethodRegistry();
    supervisor.register(methods);
    const registered = methods.get(method)!;
    return registered.handler(registered.params.parse(params), {} as RpcCallContext);
  }

  it('lists records with positions for waiting items', async () => {
    await supervisor.invoke(invocation(['research'], ['a']), DISPLAYED);
    await supervisor.invoke(invocation(['research'], ['b']), DISPLAYED);
    await supervisor.invoke(invocation(['research'], ['c']), DISPLAYED);
    await supervisor.invoke(invocation(['research'], ['d']), DISPLAYED);
    const { items } = (await call('queue.list', {})) as {
      items: { state: string; position?: number }[];
    };
    expect(items.map((item) => [item.state, item.position])).toEqual([
      ['spawning', undefined],
      ['spawning', undefined],
      ['queued', 1],
      ['queued', 2],
    ]);
  });

  it('needs confirmation to start a start_unknown item, then starts it', async () => {
    supervisor = make({ spawn: () => Promise.reject(new Error('x')) });
    const unknown = await supervisor.invoke(invocation(['research'], ['q']), DISPLAYED);
    supervisor = make();
    const refused = await call('queue.start', { invocation_id: unknown.invocation_id }).catch(
      (caught: unknown) => caught,
    );
    expect(refused).toMatchObject({ code: -32006 });
    expect((refused as RpcError).message).toContain('may already have run');
    const started = (await call('queue.start', {
      invocation_id: unknown.invocation_id,
      acknowledge_duplicate_risk: true,
    })) as { state: string };
    expect(started.state).toBe('spawning');
    expect(launches).toHaveLength(1);
  });

  it('starts a never_started item again without confirmation', async () => {
    const started = await supervisor.invoke(invocation(['research'], ['q']), DISPLAYED);
    await supervisor.cancel(started.invocation_id);
    const again = (await call('queue.start', { invocation_id: started.invocation_id })) as {
      state: string;
    };
    expect(again.state).toBe('spawning');
    expect(launches).toHaveLength(2);
  });

  it('discards a waiting item and refuses to discard a started one', async () => {
    const started = await supervisor.invoke(invocation(['research'], ['q']), DISPLAYED);
    await supervisor.invoke(invocation(['research'], ['b']), DISPLAYED);
    const waiting = await supervisor.invoke(invocation(['research'], ['c']), DISPLAYED);
    expect(
      ((await call('queue.discard', { invocation_id: waiting.invocation_id })) as { state: string })
        .state,
    ).toBe('discarded');
    await expect(
      call('queue.discard', { invocation_id: started.invocation_id }),
    ).rejects.toMatchObject({
      code: -32003,
    });
  });
});

describe('results', () => {
  it('turns a written result into one invocation.result notice', async () => {
    const started = await supervisor.invoke(invocation(['research'], ['q']), DISPLAYED);
    await store.claim(started.invocation_id, { pid: 1, startToken: 'w' });
    const outcome = {
      type: 'result' as const,
      exit_code: 0 as const,
      envelope: { ok: true },
      text: null,
    };
    await store.writeResult(started.invocation_id, outcome);

    await supervisor.dequeue();
    await vi.waitFor(() => {
      expect(notices.filter(([method]) => method === 'invocation.result')).toHaveLength(1);
    });
    await supervisor.dequeue();

    const results = notices.filter(([method]) => method === 'invocation.result');
    expect(results).toEqual([
      ['invocation.result', { invocation_id: started.invocation_id, outcome }],
    ]);
  });
});
