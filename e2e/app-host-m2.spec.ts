/**
 * @no-llm The Yantra app, M2 end to end (FEAT-065 TASK-019).
 *
 * The built CLI starts a real host; a window launches a real
 * `research --no-llm` through `command.invoke` and follows its `run.event`s.
 * Mid-run the host is killed: the detached worker keeps running, a second
 * `yantra ui --print` starts a new host that recovers and reattaches, and a
 * window following from where it left off sees every remaining event (no
 * gap, no duplicate) through the run's terminal outcome.
 *
 * Runs in the `LLM_PROVIDER=none` dimension.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { HostLockRecord, InvocationRecord, UiOpenResult, generateUlid } from '@yantra/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

const BIN = resolve(import.meta.dirname, '..', 'apps', 'cli', 'dist', 'bin.js');

let home: string;
const hostPids: number[] = [];

function env(): NodeJS.ProcessEnv {
  return { ...process.env, YANTRA_HOME: home, LLM_PROVIDER: 'none', YANTRA_UI_ASSETS_DIR: '' };
}

function openUi(): UiOpenResult {
  const opened = UiOpenResult.parse(
    JSON.parse(
      execFileSync(process.execPath, [BIN, 'ui', '--print', '--json'], {
        env: env(),
        encoding: 'utf8',
      }),
    ),
  );
  hostPids.push(opened.hostPid);
  return opened;
}

function exchange(port: number, code: string): Promise<{ cookie: string; capability: string }> {
  return new Promise((resolveExchange, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/session',
        agent: false,
        headers: { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => {
          body += chunk.toString();
        });
        res.on('end', () => {
          const cookie = /yantra_session=([^;]+)/u.exec(res.headers['set-cookie']?.[0] ?? '')?.[1];
          const grant = JSON.parse(body) as { window_capability?: string };
          if (cookie === undefined || grant.window_capability === undefined)
            reject(new Error(body));
          else resolveExchange({ cookie, capability: grant.window_capability });
        });
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify({ code }));
  });
}

/** A Node-side app window: authenticated socket, requests and notifications. */
class Window {
  private nextId = 1;
  private readonly waiting = new Map<number, (value: Record<string, unknown>) => void>();
  public readonly events: { seq: number; kind: string }[] = [];

  private constructor(private readonly ws: WebSocket) {
    ws.on('error', () => undefined);
    ws.on('message', (data) => {
      const text = Buffer.isBuffer(data)
        ? data.toString('utf8')
        : Buffer.concat(data as Buffer[]).toString('utf8');
      const message = JSON.parse(text) as Record<string, unknown>;
      if (typeof message.id === 'number') this.waiting.get(message.id)?.(message);
      if (message.method === 'run.event') {
        const params = message.params as { seq: number; event: { kind: string } };
        this.events.push({ seq: params.seq, kind: params.event.kind });
      }
    });
  }

  public static async open(url: string): Promise<Window> {
    const parsed = new URL(url);
    const port = Number(parsed.port);
    const { cookie, capability } = await exchange(port, parsed.hash.slice('#code='.length));
    const ws = new WebSocket(`ws://127.0.0.1:${port}/rpc`, {
      origin: `http://127.0.0.1:${port}`,
      headers: { cookie: `yantra_session=${cookie}` },
    });
    await new Promise<void>((done, reject) => {
      ws.once('open', () => done());
      ws.once('error', reject);
    });
    ws.send(
      JSON.stringify({ jsonrpc: '2.0', method: 'auth', params: { window_capability: capability } }),
    );
    return new Window(ws);
  }

  public call(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return new Promise((done) => {
      this.waiting.set(id, done);
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', method, params, id }));
    });
  }

  public close(): void {
    this.ws.close();
  }
}

function record(id: string): InvocationRecord | null {
  const path = join(home, 'data', 'ui', 'invocations', `${id}.json`);
  if (!existsSync(path)) return null;
  try {
    return InvocationRecord.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return null;
  }
}

async function until<T>(
  read: () => T | null | undefined | false,
  timeoutMs: number,
  what: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== null && value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 100));
  }
}

beforeAll(() => {
  if (!existsSync(BIN))
    throw new Error('Run `pnpm build` first: the e2e suite runs the built CLI.');
  home = mkdtempSync(join(tmpdir(), 'yantra-e2e-m2-'));
});

afterAll(async () => {
  for (const pid of hostPids) {
    try {
      process.kill(pid);
    } catch {
      // Already gone.
    }
  }
  await new Promise((done) => setTimeout(done, 1_000));
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
});

describe('@no-llm app-launched runs survive the host', () => {
  it('follows a research run across a host kill and a reattach, with no gap or duplicate', async () => {
    // Arrange: a host and a window; launch a real deterministic research run.
    const first = openUi();
    const window1 = await Window.open(first.url);
    const id = generateUlid();
    const invoked = await window1.call('command.invoke', {
      invocation: {
        invocation_id: id,
        path: ['research'],
        argv: [
          '--no-llm',
          '--pipeline-timeout',
          '20s',
          '--max-sources',
          '2',
          'host survival check',
        ],
        cwd: home,
      },
      displayed_effective: { settings: [], content: [] },
    });
    expect(invoked.error).toBeUndefined();
    const runId = await until(() => record(id)?.run_id, 60_000, 'the worker to own its run');
    await window1.call('run.subscribe', { run_id: runId, from_seq: 1 });
    await until(() => window1.events.length > 0, 30_000, 'the first live event');

    // Act: kill the host mid-run; the worker keeps going.
    const lock = HostLockRecord.parse(
      JSON.parse(readFileSync(join(home, 'data', 'ui', 'host.lock'), 'utf8')),
    );
    process.kill(lock.pid);
    window1.close();
    const seen = [...window1.events];
    const second = openUi();
    expect(second.hostPid).not.toBe(first.hostPid);
    const window2 = await Window.open(second.url);
    const nextSeq = (seen.at(-1)?.seq ?? 0) + 1;
    await window2.call('run.subscribe', { run_id: runId, from_seq: nextSeq });
    await until(
      () => window2.events.some((event) => event.kind === 'run_outcome'),
      120_000,
      'the run outcome',
    );

    // Assert: the two windows together saw 1..N exactly once, ending in run_outcome.
    const seqs = [...seen, ...window2.events].map((event) => event.seq);
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, index) => index + 1));
    expect(window2.events.at(-1)?.kind).toBe('run_outcome');
    await until(() => record(id)?.state === 'finished', 30_000, 'the invocation to finish');
    window2.close();
  }, 240_000);
});
