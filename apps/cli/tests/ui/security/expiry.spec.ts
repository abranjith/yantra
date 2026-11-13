// @no-llm
/**
 * Localhost security suite, expiry on a stepped clock (FEAT-065 TASK-013).
 *
 * A whole host runtime runs in-process with an injected clock, so 60 s,
 * 5 minutes and 12 hours pass instantly. Everything else is real: the lock,
 * HTTP, sessions, the WebSocket and the control socket.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  FileHostLock,
  resetPathCache,
  type LivenessVerdict,
  type ProcessIdentity,
  type ProcessLivenessProbe,
} from '@yantra/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ControlClient } from '../../../src/ui/host/control-socket.js';
import { startHostRuntime, type RunningHost } from '../../../src/ui/host/host-runtime.js';
import {
  ABSOLUTE_TTL_MS,
  CODE_TTL_MS,
  DISCONNECT_GRACE_MS,
} from '../../../src/ui/host/sessions.js';
import { connect, connectAuthenticated } from '../host/rpc-support.js';
import { cleanupTempDirs, makeWebBuild } from '../host/support.js';

import { exchange } from './support.js';

class AliveProbe implements ProcessLivenessProbe {
  public identify(pid: number): Promise<ProcessIdentity | null> {
    return Promise.resolve({ pid, startToken: 't' });
  }
  public check(): Promise<LivenessVerdict> {
    return Promise.resolve('alive');
  }
}

let home: string;
let previousHome: string | undefined;
let clock: number;
let host: RunningHost;

async function launchCode(): Promise<string> {
  const client = await ControlClient.connect(
    host.record.control_socket!,
    host.record.control_token,
  );
  const { code } = await client.issueLaunchCode();
  client.close();
  return code;
}

beforeEach(async () => {
  previousHome = process.env.YANTRA_HOME;
  home = mkdtempSync(join(tmpdir(), 'yantra-expiry-'));
  process.env.YANTRA_HOME = home;
  resetPathCache();
  clock = Date.parse('2026-11-11T10:00:00.000Z');
  host = await startHostRuntime({
    assetsRoot: makeWebBuild(),
    identity: { pid: 990_001, startToken: 't' },
    yantraVersion: '1.0.0',
    lock: new FileHostLock({ liveness: new AliveProbe() }),
    now: () => new Date(clock),
  });
});

afterEach(async () => {
  await host.stop();
  if (previousHome === undefined) delete process.env.YANTRA_HOME;
  else process.env.YANTRA_HOME = previousHome;
  resetPathCache();
  rmSync(home, { recursive: true, force: true });
  cleanupTempDirs();
});

describe('launch codes', () => {
  it('refuses an expired launch code (60 s plus 1 ms)', async () => {
    const code = await launchCode();
    clock += CODE_TTL_MS + 1;
    expect((await exchange(host.port, code)).response.status).toBe(401);
  });
});

describe('capabilities', () => {
  it('refuses a capability 5 minutes after its last socket closed', async () => {
    // Arrange: a window connects, then goes away.
    const { cookie, capability } = await exchange(host.port, await launchCode());
    const socket = await connectAuthenticated(host.port, cookie!, capability!);
    socket.ws.close();
    await socket.closed;
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Act
    clock += DISCONNECT_GRACE_MS;
    host.rpc.sweep();

    // Assert: the cookie no longer opens a socket at all.
    await expect(connect(host.port, { cookie: cookie! })).rejects.toThrow(
      'unexpected-response:403',
    );
  });

  it('keeps a capability whose window reconnects within the grace period', async () => {
    const { cookie, capability } = await exchange(host.port, await launchCode());
    const first = await connectAuthenticated(host.port, cookie!, capability!);
    first.ws.close();
    await first.closed;
    await new Promise((resolve) => setTimeout(resolve, 50));
    clock += DISCONNECT_GRACE_MS - 1;
    const again = await connectAuthenticated(host.port, cookie!, capability!);
    expect(again.received[0]).toMatchObject({ method: 'host.build' });
    again.ws.close();
  });

  it('ends a connected window at 12 hours, closing its socket with 4401', async () => {
    const { cookie, capability } = await exchange(host.port, await launchCode());
    const socket = await connectAuthenticated(host.port, cookie!, capability!);
    clock += ABSOLUTE_TTL_MS;
    host.rpc.sweep();
    expect(await socket.closed).toBe(4401);
    await expect(connect(host.port, { cookie: cookie! })).rejects.toThrow(
      'unexpected-response:403',
    );
  });

  it('refuses a replayed capability on a second socket after it was rotated by a resume', async () => {
    // Arrange
    const { cookie, capability } = await exchange(host.port, await launchCode());
    const socket = await connectAuthenticated(host.port, cookie!, capability!);
    const { code } = (await socket.call('session.resume_code')).result as { code: string };

    // Act: the tab reloads and resumes; the old capability is replayed.
    const resumed = await exchange(host.port, code);
    const replay = await connect(host.port, { cookie: resumed.cookie! });
    replay.send({ jsonrpc: '2.0', method: 'auth', params: { window_capability: capability } });

    // Assert
    expect(await replay.closed).toBe(4401);
    socket.ws.close();
  });
});
