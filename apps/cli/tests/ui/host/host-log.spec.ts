// @no-llm
/**
 * `host.log` (FEAT-065 TASK-005): rotation, owner-only mode, and redaction
 * proven with a canary scan over a log written by a real host.
 */

import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  HOST_LOG_ROTATE_BYTES,
  REDACTED,
  openHostLog,
  rotateIfLarge,
  scrubSecrets,
} from '../../../src/ui/host/host-log.js';
import { AppHost } from '../../../src/ui/host/host.js';
import { RpcMethodRegistry, RpcServer } from '../../../src/ui/host/rpc-server.js';
import { SessionStore, sessionRoute } from '../../../src/ui/host/sessions.js';

import { connectAuthenticated } from './rpc-support.js';
import { cleanupTempDirs, makeTempDir, makeWebBuild, rawRequest } from './support.js';

afterEach(() => {
  cleanupTempDirs();
});

describe('scrubSecrets', () => {
  it.each([
    'code',
    'launch_code',
    'resume_code',
    'cookie',
    'window_capability',
    'control_token',
    'run_token',
    'api_secret',
    'secret',
    'signed_url',
    'url',
    'password',
    'Authorization',
  ])('replaces %s at any depth', (key) => {
    const value = { a: { b: [{ [key]: 'CANARY' }] }, [key]: 'CANARY' };
    expect(JSON.stringify(scrubSecrets(value))).not.toContain('CANARY');
  });

  it.each(['reason', 'port', 'build_id', 'invocation_id', 'run_id', 'origin_host', 'count'])(
    'keeps %s',
    (key) => {
      expect(scrubSecrets({ [key]: 'visible' })).toEqual({ [key]: 'visible' });
    },
  );
});

describe('rotation', () => {
  it('moves a log over the limit to host.log.1 at start', () => {
    const path = join(makeTempDir(), 'host.log');
    writeFileSync(path, 'x'.repeat(100));
    expect(rotateIfLarge(path, 50)).toBe(true);
    expect(readFileSync(`${path}.1`, 'utf8')).toHaveLength(100);
  });

  it('keeps a log under the limit', () => {
    const path = join(makeTempDir(), 'host.log');
    writeFileSync(path, 'x');
    expect(rotateIfLarge(path)).toBe(false);
    expect(HOST_LOG_ROTATE_BYTES).toBe(10 * 1024 * 1024);
  });

  it('replaces an older host.log.1', () => {
    const path = join(makeTempDir(), 'host.log');
    writeFileSync(`${path}.1`, 'old');
    writeFileSync(path, 'new-and-long');
    rotateIfLarge(path, 5);
    expect(readFileSync(`${path}.1`, 'utf8')).toBe('new-and-long');
  });

  it('opens a fresh file after rotating', () => {
    const path = join(makeTempDir(), 'host.log');
    writeFileSync(path, 'x'.repeat(100));
    const log = openHostLog(path, { rotateBytes: 50 });
    log.logger.info({ reason: 'test' }, 'fresh');
    log.flush();
    expect(readFileSync(path, 'utf8')).toContain('"fresh"');
    expect(readFileSync(path, 'utf8')).not.toContain('xxxx');
  });
});

describe.skipIf(process.platform === 'win32')('file mode', () => {
  it('is owner-only', () => {
    const path = join(makeTempDir(), 'host.log');
    const log = openHostLog(path);
    log.logger.info({}, 'x');
    log.flush();
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe('canary scan', () => {
  it('finds no code, cookie, capability, token or secret in host.log after a real session', async () => {
    // Arrange: a host that logs to a real host.log.
    const path = join(makeTempDir(), 'host.log');
    const log = openHostLog(path);
    const sessions = new SessionStore();
    const rpc = new RpcServer({
      sessions,
      methods: new RpcMethodRegistry(),
      buildId: () => 'b',
      yantraVersion: '1',
      logger: log.logger,
    });
    const host = new AppHost({
      assetsRoot: makeWebBuild(),
      logger: log.logger,
      routes: [sessionRoute(sessions, () => 'b')],
      upgrade: rpc.handleUpgrade,
    });
    const { port } = await host.start();
    const canaries: string[] = [];

    // Act: issue codes, exchange one over HTTP, authenticate a socket, log secrets on purpose.
    const launch = sessions.issueLaunchCode().code;
    canaries.push(launch, sessions.issueLaunchCode().code);
    const response = await rawRequest(port, {
      method: 'POST',
      path: '/session',
      headers: { origin: `http://127.0.0.1:${port}` },
      body: JSON.stringify({ code: launch }),
    });
    const grant = JSON.parse(response.body.toString()) as { window_capability: string };
    const cookie = (response.headers['set-cookie']?.[0] ?? '').split(';')[0]!.split('=')[1]!;
    canaries.push(grant.window_capability, cookie);
    const socket = await connectAuthenticated(port, cookie, grant.window_capability);
    const resume = await socket.call('session.resume_code');
    canaries.push((resume.result as { code: string }).code);
    await rawRequest(port, {
      method: 'POST',
      path: '/session',
      headers: { origin: 'https://evil.example' },
      body: JSON.stringify({ code: 'CANARY-REFUSED-CODE' }),
    });
    canaries.push(
      'CANARY-REFUSED-CODE',
      'CANARY-SECRET-VALUE',
      'CANARY-SIGNED-URL',
      'CANARY-NESTED',
    );
    log.logger.info(
      {
        secret: 'CANARY-SECRET-VALUE',
        signed_url: 'CANARY-SIGNED-URL',
        details: { inner: { api_token: 'CANARY-NESTED' } },
      },
      'deliberately logging secret-named fields',
    );
    socket.ws.close();
    rpc.close();
    await host.stop();
    log.flush();

    // Assert
    const text = readFileSync(path, 'utf8');
    expect(text).toContain(REDACTED);
    expect(text).toContain('request refused');
    for (const canary of canaries) expect(text).not.toContain(canary);
  });
});
