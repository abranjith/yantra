// @no-llm
/**
 * Localhost security suite, real host process (FEAT-065 TASK-013, plan §10,
 * D18). A merge gate: CI runs it on Windows, macOS and Linux.
 *
 * The host is started exactly as `yantra ui` starts it. Each case is one
 * attack a page, another local service or a stray client could make.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { connect as netConnect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

import { encodeJsonFrame } from '@yantra/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { connect, connectAuthenticated, type TestSocket } from '../host/rpc-support.js';
import { rawRequest, type RawResponse } from '../host/support.js';

import { codeOf, exchange, startRealHost, type RealHost } from './support.js';

const RUN = '20261111T100000Z-research-0000abcd';
const CANARY_ENV_SECRET = 'sk-ant-CANARY-ENV-0123456789abcdef';
const CANARY_RUN_TOKEN = 'CANARYRUNTOKEN0123456789abcdefghijklmnopqrs';
const CANARY_FILE_SECRET = 'CANARY-SECRET-IN-RUN-FILE';

let host: RealHost;
let port: number;
/** Every HTTP response and WebSocket message the host sent, for the canary scans. */
const outbound: string[] = [];

function record(response: RawResponse): RawResponse {
  outbound.push(JSON.stringify(response.headers), response.body.toString('latin1'));
  return response;
}

async function request(options: Parameters<typeof rawRequest>[1]): Promise<RawResponse> {
  return record(await rawRequest(port, options));
}

async function session(): Promise<{ cookie: string; capability: string }> {
  const { cookie, capability, response } = await exchange(port, codeOf(host.open().url));
  record(response);
  if (cookie === null || capability === null) throw new Error('session refused');
  return { cookie, capability };
}

function captureSocket(socket: TestSocket): TestSocket {
  socket.ws.on('message', (data) => {
    outbound.push(String(data));
  });
  return socket;
}

beforeAll(() => {
  host = startRealHost({ ANTHROPIC_API_KEY: CANARY_ENV_SECRET });
  port = host.port;
  // A run directory with the files that must never leave the host.
  const runDir = join(host.dataDir(), 'runs', RUN);
  mkdirSync(join(runDir, 'decisions'), { recursive: true });
  mkdirSync(join(runDir, 'captures'), { recursive: true });
  writeFileSync(join(runDir, 'lease.json'), JSON.stringify({ run_token: CANARY_RUN_TOKEN }));
  writeFileSync(join(runDir, 'reconcile.lock'), CANARY_FILE_SECRET);
  writeFileSync(join(runDir, 'decisions', 'd1.json'), CANARY_FILE_SECRET);
  writeFileSync(join(runDir, 'report.md'), '# Report\n');
  mkdirSync(join(host.dataDir(), 'ui', 'invocations'), { recursive: true });
  writeFileSync(join(host.dataDir(), 'ui', 'invocations', 'x.json'), CANARY_FILE_SECRET);
}, 60_000);

afterAll(async () => {
  await host.stop();
});

describe('launch codes', () => {
  it('refuses a missing launch code', async () => {
    const response = await request({
      method: 'POST',
      path: '/session',
      headers: { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(401);
    expect(response.body.toString()).toBe('{"error":"session_refused"}');
  });

  it('refuses a replayed launch code', async () => {
    const code = codeOf(host.open().url);
    expect((await exchange(port, code)).response.status).toBe(200);
    const replay = await exchange(port, code);
    record(replay.response);
    expect(replay.response.status).toBe(401);
  });

  it('issues a different single-use code on every yantra ui', () => {
    expect(codeOf(host.open().url)).not.toBe(codeOf(host.open().url));
  });
});

describe('capabilities', () => {
  it('refuses a session cookie presented without a capability', async () => {
    const { cookie } = await session();
    const socket = captureSocket(await connect(port, { cookie }));
    socket.send({ jsonrpc: '2.0', method: 'auth', params: {} });
    expect(await socket.closed).toBe(4401);
    expect(socket.received).toEqual([]);
  });

  it('refuses a capability without its cookie', async () => {
    const { capability } = await session();
    await expect(connect(port, { cookie: null })).rejects.toThrow('unexpected-response:403');
    expect(capability.length).toBeGreaterThan(0);
  });
});

describe('a page on another loopback port', () => {
  let other: Server;
  let otherOrigin: string;

  beforeAll(async () => {
    other = createServer((_req, res) => {
      res.end('<script>/* a hostile local page */</script>');
    });
    await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
    otherOrigin = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => other.close(resolve));
  });

  it('cannot use the cookie (same site, other port) to open a session', async () => {
    // The browser attaches the SameSite=Strict cookie across ports; the Origin gives it away.
    const { cookie } = await session();
    const response = await request({
      method: 'POST',
      path: '/session',
      headers: {
        origin: otherOrigin,
        cookie: `yantra_session=${cookie}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ code: codeOf(host.open().url) }),
    });
    expect(response.status).toBe(403);
  });

  it('cannot open the WebSocket with the cookie', async () => {
    const { cookie } = await session();
    await expect(connect(port, { cookie, origin: otherOrigin })).rejects.toThrow(
      'unexpected-response:403',
    );
  });

  it('gets no CORS permission to read any response', async () => {
    const response = await request({ path: '/', headers: { origin: otherOrigin } });
    expect(
      Object.keys(response.headers).filter((name) => name.startsWith('access-control-')),
    ).toEqual([]);
  });
});

describe('origin and host', () => {
  it('refuses a foreign Origin', async () => {
    const response = await request({
      method: 'POST',
      path: '/session',
      headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
      body: '{"code":"x"}',
    });
    expect(response.status).toBe(403);
  });

  it('refuses a DNS-rebinding Host', async () => {
    const response = await request({ path: '/', headers: { host: `rebind.evil.example:${port}` } });
    expect(response.status).toBe(421);
    expect(response.body.length).toBe(0);
  });

  it('refuses a cross-site form POST to /session', async () => {
    const response = await request({
      method: 'POST',
      path: '/session',
      headers: {
        origin: 'https://evil.example',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: `code=${codeOf(host.open().url)}`,
    });
    expect(response.status).toBe(403);
  });
});

describe('the control socket', () => {
  it('answers nothing to an unauthenticated client', async () => {
    const lock = host.lock();
    const replies: Buffer[] = [];
    await new Promise<void>((resolve) => {
      const socket = netConnect(lock.control_socket!);
      socket.on('data', (chunk: Buffer) => replies.push(chunk));
      socket.on('error', () => undefined);
      socket.once('connect', () => {
        socket.write(
          encodeJsonFrame({ type: 'hello', control_token: 'wrong', channel_version: 1 }),
        );
        socket.write(encodeJsonFrame({ type: 'launch_code.issue', id: 1 }));
      });
      socket.once('close', () => resolve());
    });
    expect(replies).toEqual([]);
  });
});

describe('files that never leave the host', () => {
  it.each([
    '/lease.json',
    '/host.lock',
    '/ui/host.lock',
    '/invocations/x.json',
    `/runs/${RUN}/lease.json`,
    `/runs/${RUN}/decisions/d1.json`,
    `/runs/${RUN}/reconcile.lock`,
    '/assets/../../host.lock',
    '/assets/%2e%2e/%2e%2e/ui/host.lock',
    `/assets/..%2f..%2fruns%2f${RUN}%2flease.json`,
  ])('are not served at the static path %s', async (path) => {
    const response = await request({ path });
    expect(response.body.toString()).not.toContain(CANARY_RUN_TOKEN);
    expect(response.body.toString()).not.toContain(CANARY_FILE_SECRET);
    expect(response.body.toString()).not.toContain('control_token');
  });

  it.each([
    'lease.json',
    'decisions/d1.json',
    'reconcile.lock',
    '../../ui/host.lock',
    '../../ui/invocations/x.json',
  ])('cannot be signed through artifact.url (%s)', async (path) => {
    const { cookie, capability } = await session();
    const socket = captureSocket(await connectAuthenticated(port, cookie, capability));
    const reply = await socket.call('artifact.url', { run_id: RUN, path });
    socket.ws.close();
    expect(reply.error).toBeDefined();
    expect([-32003, -32602]).toContain((reply.error as { code: number }).code);
  });

  it('rejects forged /a/ URLs', async () => {
    const payload = Buffer.from(
      JSON.stringify({ r: RUN, p: 'lease.json', w: 'w', e: Date.now() + 60_000 }),
    ).toString('base64url');
    const response = await request({ path: `/a/${payload}.AAAA` });
    expect(response.status).toBe(404);
  });
});

describe('outbound canary scans', () => {
  it('finds no secret, token, code or capability in any host→app byte or in host.log', async () => {
    // Arrange: an unused launch code, and a window that exercises every M1 surface.
    const unusedCode = codeOf(host.open().url);
    const { cookie, capability } = await session();
    const socket = captureSocket(await connectAuthenticated(port, cookie, capability));
    for (const [method, params] of [
      ['host.hello', { build_id: 'x', channel_version: 1 }],
      ['read.list', {}],
      ['read.show', { args: [RUN], options: { run: true } }],
      ['read.audit', { args: [RUN] }],
      ['read.report', { args: [RUN] }],
      ['read.prefs.list', {}],
      ['read.profile', {}],
      ['read.daemon.status', {}],
      ['runs.subscribe', {}],
      ['artifact.url', { run_id: RUN, path: 'report.md' }],
    ] as const) {
      await socket.call(method, params);
    }
    const signed = (await socket.call('artifact.url', { run_id: RUN, path: 'report.md' }))
      .result as {
      url: string;
    };
    await request({ path: signed.url, headers: { cookie: `yantra_session=${cookie}` } });
    await request({ path: '/' });
    socket.ws.close();
    await socket.closed;
    const lock = host.lock();

    // Act
    const sent = outbound.join('\n');
    const log = readFileSync(join(host.dataDir(), 'ui', 'host.log'), 'utf8');

    // Assert: never sent to the app…
    for (const canary of [
      CANARY_ENV_SECRET,
      CANARY_RUN_TOKEN,
      CANARY_FILE_SECRET,
      lock.control_token,
      unusedCode,
    ]) {
      expect(sent).not.toContain(canary);
    }
    // …and nothing secret reaches the log, including this window's own values.
    for (const canary of [
      CANARY_ENV_SECRET,
      CANARY_RUN_TOKEN,
      lock.control_token,
      unusedCode,
      cookie,
      capability,
      signed.url.slice(3),
    ]) {
      expect(log).not.toContain(canary);
    }
    expect(log).toContain('host started');
  }, 120_000);
});
