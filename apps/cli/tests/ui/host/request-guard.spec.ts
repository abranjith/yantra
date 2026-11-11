// @no-llm
/**
 * The app host's HTTP boundary (FEAT-065 TASK-002, plan D18): exact Host,
 * exact Origin on mutations, a 1 MiB body cap, security headers everywhere,
 * no CORS, and a loopback-only listener.
 */

import type { IncomingMessage } from 'node:http';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AppHost, originHost, type HostRoute } from '../../../src/ui/host/host.js';
import {
  BodyTooLargeError,
  MAX_REQUEST_BODY_BYTES,
  checkRequest,
  contentSecurityPolicy,
  readBody,
  readBodyOr413,
  securityHeaders,
  sendStatus,
} from '../../../src/ui/host/request-guard.js';

import { cleanupTempDirs, makeWebBuild, rawRequest, type RawResponse } from './support.js';

/** A POST route that reads its body, so the cap can be exercised end to end. */
const echoLength: HostRoute = async (req, res, { port }) => {
  if (req.method !== 'POST' || req.url !== '/echo') return false;
  const body = await readBodyOr413(req, res, port);
  if (body !== null) sendStatus(res, port, 200, String(body.length));
  return true;
};

let host: AppHost;
let port: number;

beforeEach(async () => {
  host = new AppHost({ assetsRoot: makeWebBuild(), routes: [echoLength] });
  ({ port } = await host.start());
});

afterEach(async () => {
  await host.stop();
  cleanupTempDirs();
});

function expectSecurityHeaders(response: RawResponse): void {
  expect(response.headers['content-security-policy']).toBe(contentSecurityPolicy(port));
  expect(response.headers['x-content-type-options']).toBe('nosniff');
  expect(response.headers['referrer-policy']).toBe('no-referrer');
  expect(response.headers['x-frame-options']).toBe('DENY');
  expect(response.headers['cross-origin-opener-policy']).toBe('same-origin');
  expect(response.headers['cross-origin-resource-policy']).toBe('same-origin');
}

function expectNoCors(response: RawResponse): void {
  const cors = Object.keys(response.headers).filter((name) => name.startsWith('access-control-'));
  expect(cors).toEqual([]);
}

describe('listening', () => {
  it('binds 127.0.0.1 on an ephemeral port', () => {
    const address = host.httpServer.address();
    expect(address).toMatchObject({ address: '127.0.0.1', family: 'IPv4' });
    expect(port).toBeGreaterThan(0);
  });
});

describe('Host header (DNS-rebinding defense)', () => {
  it('answers the canonical Host', async () => {
    const response = await rawRequest(port);
    expect(response.status).toBe(200);
  });

  it.each([
    ['a foreign name', (p: number) => `evil.example:${p}`],
    ['localhost', (p: number) => `localhost:${p}`],
    ['an IPv6 loopback', (p: number) => `[::1]:${p}`],
    ['the wrong port', (p: number) => `127.0.0.1:${p + 1}`],
    ['no port', () => '127.0.0.1'],
    ['a trailing dot', (p: number) => `127.0.0.1.:${p}`],
    ['a decimal-encoded loopback', (p: number) => `2130706433:${p}`],
  ])('refuses %s with 421 and no body', async (_label, makeHost) => {
    // Act
    const response = await rawRequest(port, { headers: { host: makeHost(port) } });

    // Assert
    expect(response.status).toBe(421);
    expect(response.body.length).toBe(0);
    expectSecurityHeaders(response);
  });

  it('refuses a request with no Host header (Node answers 400 before routing)', async () => {
    const response = await rawRequest(port, { headers: { host: null } });
    expect(response.status).toBe(400);
    expect(checkRequest({ method: 'GET', headers: {} }, port)).toEqual({
      status: 421,
      reason: 'host',
    });
  });

  it('checks Host before Origin', () => {
    expect(checkRequest({ method: 'POST', headers: { host: 'x', origin: 'y' } }, 1)).toEqual({
      status: 421,
      reason: 'host',
    });
  });
});

describe('Origin on state-changing requests', () => {
  it('accepts a POST from the exact origin', async () => {
    const response = await rawRequest(port, {
      method: 'POST',
      path: '/echo',
      headers: { origin: `http://127.0.0.1:${port}` },
      body: 'abc',
    });
    expect(response.status).toBe(200);
    expect(response.body.toString()).toBe('3');
  });

  it.each([
    ['a foreign origin', 'https://evil.example'],
    ['another loopback port', 'http://127.0.0.1:1'],
    ['localhost', 'http://localhost:PORT'],
    ['the null origin', 'null'],
    ['https on the same port', 'https://127.0.0.1:PORT'],
    ['a trailing slash', 'http://127.0.0.1:PORT/'],
  ])('refuses %s with 403', async (_label, origin) => {
    const response = await rawRequest(port, {
      method: 'POST',
      path: '/echo',
      headers: { origin: origin.replace('PORT', String(port)) },
      body: 'x',
    });
    expect(response.status).toBe(403);
    expectSecurityHeaders(response);
  });

  it('refuses a POST with no Origin', async () => {
    const response = await rawRequest(port, { method: 'POST', path: '/echo', body: 'x' });
    expect(response.status).toBe(403);
  });

  it.each(['PUT', 'DELETE', 'PATCH'])('applies the Origin rule to %s', async (method) => {
    const response = await rawRequest(port, { method, path: '/echo' });
    expect(response.status).toBe(403);
  });

  it('does not need Origin for GET', async () => {
    const response = await rawRequest(port, { headers: { origin: 'https://evil.example' } });
    expect(response.status).toBe(200);
  });

  it('answers an unknown POST from the right origin with 405', async () => {
    const response = await rawRequest(port, {
      method: 'POST',
      path: '/nothing',
      headers: { origin: `http://127.0.0.1:${port}` },
    });
    expect(response.status).toBe(405);
  });

  it('counts each refusal by the rejected origin host, never the full origin', async () => {
    await rawRequest(port, {
      method: 'POST',
      path: '/echo',
      headers: { origin: 'https://evil.example/path?secret=1' },
    });
    expect(host.rejectionCounts().get('origin:evil.example')).toBe(1);
  });
});

describe('body limit', () => {
  it('answers 413 when the body is over 1 MiB', async () => {
    const response = await rawRequest(port, {
      method: 'POST',
      path: '/echo',
      headers: {
        origin: `http://127.0.0.1:${port}`,
        'transfer-encoding': 'chunked',
      },
      body: Buffer.alloc(MAX_REQUEST_BODY_BYTES + 1, 0x61),
    });
    expect(response.status).toBe(413);
    expectSecurityHeaders(response);
  });

  it('accepts a body of exactly 1 MiB', async () => {
    const response = await rawRequest(port, {
      method: 'POST',
      path: '/echo',
      headers: { origin: `http://127.0.0.1:${port}` },
      body: Buffer.alloc(MAX_REQUEST_BODY_BYTES, 0x61),
    });
    expect(response.status).toBe(200);
    expect(response.body.toString()).toBe(String(MAX_REQUEST_BODY_BYTES));
  });

  it('refuses a declared oversize Content-Length before reading any byte', async () => {
    // Arrange: a request stream that never ends.
    const stream = new PassThrough() as unknown as IncomingMessage;
    (stream as { headers: Record<string, string> }).headers = {
      'content-length': String(MAX_REQUEST_BODY_BYTES + 1),
    };

    // Act / Assert
    await expect(readBody(stream)).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  it('stops keeping a body as soon as it passes the limit, before it ends', async () => {
    // Arrange: an undeclared body that never ends.
    const stream = new PassThrough();
    const req = Object.assign(stream, { headers: {} }) as unknown as IncomingMessage;
    const pending = readBody(req, 10);

    // Act: 11 bytes arrive, the stream stays open.
    stream.write(Buffer.alloc(6));
    stream.write(Buffer.alloc(5));

    // Assert
    await expect(pending).rejects.toBeInstanceOf(BodyTooLargeError);
  });
});

describe('response headers', () => {
  it.each([
    ['the app page', '/'],
    ['a hashed asset', '/assets/main-AbC123xy.js'],
    ['a 404', '/assets/missing.js'],
  ])('sends the CSP and security headers on %s', async (_label, path) => {
    const response = await rawRequest(port, { path });
    expectSecurityHeaders(response);
    expectNoCors(response);
  });

  it('never sends CORS headers, even to a preflight', async () => {
    const response = await rawRequest(port, {
      method: 'OPTIONS',
      path: '/',
      headers: {
        origin: 'https://evil.example',
        'access-control-request-method': 'POST',
      },
    });
    expect(response.status).toBe(403);
    expectNoCors(response);
  });

  it('allows WebSocket connections only to its own port in the CSP', () => {
    expect(securityHeaders(4321)['Content-Security-Policy']).toContain(
      "connect-src 'self' ws://127.0.0.1:4321",
    );
  });
});

describe('originHost', () => {
  it.each([
    [undefined, '(none)'],
    ['null', '(invalid)'],
    ['https://a.example:8443/x', 'a.example:8443'],
  ])('reduces %s to %s', (origin, expected) => {
    expect(originHost(origin)).toBe(expected);
  });
});
