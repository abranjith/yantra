// @no-llm
/**
 * FEAT-071 TASK-010 behavior parity test:
 * Executes the host adapters for `secret.set` (with a fake keychain) and
 * `read.doctor` against a sandboxed `YANTRA_HOME`.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { YANTRA_KEYCHAIN_SERVICE, resetPathCache, type KeychainProvider } from '@yantra/core';
import { DoctorResult } from '@yantra/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { registerCredentials } from '../../../src/ui/host/credentials.js';
import { registerHealth } from '../../../src/ui/host/health.js';
import { SILENT_HOST_LOGGER } from '../../../src/ui/host/host.js';
import { AppHost } from '../../../src/ui/host/host.js';
import { RpcMethodRegistry, RpcServer } from '../../../src/ui/host/rpc-server.js';
import { SessionStore, sessionRoute } from '../../../src/ui/host/sessions.js';

import { connectAuthenticated } from './rpc-support.js';
import { makeWebBuild, rawRequest } from './support.js';

function makeFakeKeychain(): KeychainProvider & { readonly store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    isAvailable: async () => true,
    get: async (_service, account) => store.get(account) ?? null,
    set: async (_service, account, value) => {
      store.set(account, value);
    },
    delete: async (_service, account) => store.delete(account),
    list: async () => [...store.keys()].map((account) => ({ account })),
  };
}

const cleanups: (() => Promise<void> | void)[] = [];
const originalYantraHome = process.env.YANTRA_HOME;

afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) await fn();
  }
  if (originalYantraHome === undefined) delete process.env.YANTRA_HOME;
  else process.env.YANTRA_HOME = originalYantraHome;
  resetPathCache();
});

describe('@no-llm FEAT-071 behavior parity against sandboxed YANTRA_HOME', () => {
  it('executes secret.set into a fake keychain and read.doctor against a sandboxed YANTRA_HOME', async () => {
    const home = mkdtempSync(join(tmpdir(), 'yantra-behavior-071-'));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    process.env.YANTRA_HOME = home;
    resetPathCache();

    const keychain = makeFakeKeychain();
    const sessions = new SessionStore();
    const methods = new RpcMethodRegistry();
    registerCredentials(methods, { keychain, env: {}, logger: SILENT_HOST_LOGGER });
    registerHealth(methods, {
      env: { YANTRA_HOME: home, LLM_PROVIDER: 'none' },
      logger: SILENT_HOST_LOGGER,
      keychain: async () => keychain,
    });

    const webRoot = makeWebBuild();
    cleanups.push(() => rmSync(webRoot, { recursive: true, force: true }));

    const rpc = new RpcServer({
      sessions,
      methods,
      buildId: () => 'b',
      yantraVersion: '1',
      logger: SILENT_HOST_LOGGER,
    });
    const host = new AppHost({
      assetsRoot: webRoot,
      routes: [sessionRoute(sessions, () => 'b')],
      logger: SILENT_HOST_LOGGER,
      upgrade: rpc.handleUpgrade,
    });
    const { port } = await host.start();
    cleanups.push(async () => {
      await rpc.close();
      await host.stop();
    });

    const launch = sessions.issueLaunchCode().code;
    const sessionRes = await rawRequest(port, {
      method: 'POST',
      path: '/session',
      headers: {
        origin: `http://127.0.0.1:${port}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ code: launch }),
    });
    expect(sessionRes.status).toBe(200);
    const cookie = (sessionRes.headers['set-cookie']?.[0] ?? '').split(';')[0]!.split('=')[1]!;
    const { window_capability: capability } = JSON.parse(sessionRes.body.toString('utf8')) as {
      window_capability: string;
    };

    const client = await connectAuthenticated(port, cookie, capability);
    cleanups.push(() => {
      client.ws.close();
    });

    const canary = 'CANARY-BEHAVIOR-SECRET-071';
    const setReply = await client.call('secret.set', { key: 'tavily.api_key', value: canary });
    expect(setReply.result).toEqual({ status: 'set', key: 'tavily.api_key' });
    expect(JSON.stringify(setReply)).not.toContain(canary);
    expect(await keychain.get(YANTRA_KEYCHAIN_SERVICE, 'tavily.api_key')).toBe(canary);

    const doctorReply = await client.call('read.doctor', { refresh: true });
    const parsed = DoctorResult.parse(doctorReply.result);
    expect(parsed.checks.length).toBeGreaterThan(0);
    expect(parsed.checks.some((c) => c.id === 'keychain.reachable' && c.status === 'ok')).toBe(
      true,
    );
  });
});
