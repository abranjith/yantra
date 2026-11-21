// @no-llm
/**
 * Host credentials RPC (`secret.list`, `secret.set`, `secret.rm`, FEAT-071 TASK-002):
 * round-trip, capability enforcement, zero child_process/worker spawns, and
 * canary scans across responses, error payloads, and `host.log`.
 */

import childProcess from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { type KeychainProvider } from '@yantra/core';
import { ok } from '@yantra/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerCredentials } from '../../../src/ui/host/credentials.js';
import { openHostLog } from '../../../src/ui/host/host-log.js';
import { AppHost } from '../../../src/ui/host/host.js';
import {
  REDACTED_RPC_PARAM_METHODS,
  RpcMethodRegistry,
  RpcServer,
  redactRpcParams,
} from '../../../src/ui/host/rpc-server.js';
import { SessionStore, sessionRoute } from '../../../src/ui/host/sessions.js';
import * as workerSpawn from '../../../src/worker/spawn.js';

import { connect, connectAuthenticated } from './rpc-support.js';
import { cleanupTempDirs, makeTempDir, makeWebBuild, rawRequest } from './support.js';

const CANARY = 'CANARY_SECRET_VALUE_9911';

function makeFakeKeychain(available = true): KeychainProvider & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    isAvailable: async () => available,
    get: async (_service, account) => store.get(account) ?? null,
    set: async (_service, account, value) => {
      store.set(account, value);
    },
    delete: async (_service, account) => store.delete(account),
    list: async () => [...store.keys()].map((account) => ({ account })),
  };
}

async function startTestHost(options: {
  readonly keychain: KeychainProvider;
  readonly logPath?: string;
}) {
  const log = openHostLog(options.logPath ?? join(makeTempDir(), 'host.log'));
  const sessions = new SessionStore();
  const methods = new RpcMethodRegistry();
  registerCredentials(methods, {
    keychain: options.keychain,
    env: {},
    loadConfig: async () =>
      ok({
        version: 1,
        paths: { data_dir: null, cache_dir: null },
        models: [
          {
            provider: 'anthropic',
            id: 'claude-opus-4-7',
            api_key: { kind: 'secret', key: 'anthropic.api_key' },
          },
        ],
        search: {
          provider: null,
          tavily: { api_key: { kind: 'secret', key: 'tavily.api_key' } },
          brave: { api_key: null },
        },
        ethics: { robots: 'respect' },
      }) as never,
    logger: log.logger,
  });
  const rpc = new RpcServer({
    sessions,
    methods,
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
  return {
    port,
    log,
    sessions,
    openSocket: async () => {
      const launch = sessions.issueLaunchCode().code;
      const response = await rawRequest(port, {
        method: 'POST',
        path: '/session',
        headers: { origin: `http://127.0.0.1:${port}` },
        body: JSON.stringify({ code: launch }),
      });
      const grant = JSON.parse(response.body.toString()) as { window_capability: string };
      const cookie = (response.headers['set-cookie']?.[0] ?? '').split(';')[0]!.split('=')[1]!;
      return connectAuthenticated(port, cookie, grant.window_capability);
    },
    stop: async () => {
      rpc.close();
      await host.stop();
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  cleanupTempDirs();
});

describe('host credentials RPC', () => {
  it('round-trips secret.set, secret.list, and secret.rm in-process without spawning', async () => {
    const keychain = makeFakeKeychain(true);
    const logPath = join(makeTempDir(), 'host.log');
    const spawnSpy = vi.spyOn(childProcess, 'spawn');
    const workerSpy = vi.spyOn(workerSpawn, 'spawnDetachedWorker');

    const server = await startTestHost({ keychain, logPath });
    try {
      const socket = await server.openSocket();

      const setReply = await socket.call('secret.set', {
        key: 'tavily.api_key',
        value: CANARY,
      });
      expect(setReply.result).toEqual({ status: 'set', key: 'tavily.api_key' });
      expect(JSON.stringify(setReply)).not.toContain(CANARY);
      expect(keychain.store.get('tavily.api_key')).toBe(CANARY);

      const listReply = await socket.call('secret.list', {});
      expect(listReply.error).toBeUndefined();
      expect(JSON.stringify(listReply)).not.toContain(CANARY);
      expect(listReply.result).toEqual({
        available: true,
        remedy: null,
        rows: expect.arrayContaining([
          {
            key: 'tavily.api_key',
            source: 'keychain',
            referenced_by: [
              { kind: 'search', id: 'tavily', ref: { kind: 'secret', key: 'tavily.api_key' } },
            ],
          },
        ]),
      });

      const rmReply = await socket.call('secret.rm', { key: 'tavily.api_key' });
      expect(rmReply.result).toEqual({ status: 'removed', key: 'tavily.api_key' });
      expect(keychain.store.has('tavily.api_key')).toBe(false);

      const rmAbsent = await socket.call('secret.rm', { key: 'tavily.api_key' });
      expect(rmAbsent.result).toEqual({ status: 'absent', key: 'tavily.api_key' });

      expect(spawnSpy).not.toHaveBeenCalled();
      expect(workerSpy).not.toHaveBeenCalled();

      server.log.flush();
      const logContents = readFileSync(logPath, 'utf8');
      expect(logContents).not.toContain(CANARY);
      expect(logContents).toContain('"credential_changed"');
      expect(logContents).toContain('"op":"set"');
      expect(logContents).toContain('"op":"rm"');
      expect(logContents).toContain('"key":"tavily.api_key"');
    } finally {
      await server.stop();
    }
  });

  it('never leaks canary values in error payloads or host.log when keychain is unavailable or params are invalid', async () => {
    const keychain = makeFakeKeychain(false);
    // Simulate a native keychain throwing an error that embeds the secret value.
    keychain.isAvailable = async () => {
      throw new Error(`native keychain error with ${CANARY}`);
    };
    const logPath = join(makeTempDir(), 'host.log');
    const server = await startTestHost({ keychain, logPath });
    try {
      const socket = await server.openSocket();

      const unavailableReply = await socket.call('secret.set', {
        key: 'tavily.api_key',
        value: CANARY,
      });
      expect(unavailableReply.error).toBeDefined();
      expect(JSON.stringify(unavailableReply)).not.toContain(CANARY);
      const errObj = unavailableReply.error as {
        code: number;
        message: string;
        data: { code: string; message: string; remediation?: string };
      };
      expect(Object.keys(errObj.data).sort()).toEqual(['code', 'message', 'remediation']);

      const invalidKeyReply = await socket.call('secret.set', {
        key: 'BAD KEY',
        value: CANARY,
      });
      expect(invalidKeyReply.error).toBeDefined();
      expect(JSON.stringify(invalidKeyReply)).not.toContain(CANARY);

      server.log.flush();
      const logContents = readFileSync(logPath, 'utf8');
      expect(logContents).not.toContain(CANARY);
    } finally {
      await server.stop();
    }
  });

  it('rejects unauthenticated sockets before credential handlers run', async () => {
    const keychain = makeFakeKeychain(true);
    const setSpy = vi.spyOn(keychain, 'set');
    const server = await startTestHost({ keychain });
    try {
      await expect(connect(server.port)).rejects.toThrow(/403/);
      expect(setSpy).not.toHaveBeenCalled();
    } finally {
      await server.stop();
    }
  });

  it('redacts secret.set and onboarding.submit params to {method, key}', () => {
    expect(REDACTED_RPC_PARAM_METHODS.has('secret.set')).toBe(true);
    expect(REDACTED_RPC_PARAM_METHODS.has('onboarding.submit')).toBe(true);
    expect(redactRpcParams('secret.set', { key: 'tavily.api_key', value: CANARY })).toEqual({
      method: 'secret.set',
      key: 'tavily.api_key',
    });
    expect(
      redactRpcParams('onboarding.submit', {
        answers: {},
        secrets: { credential_secret: CANARY },
      }),
    ).toEqual({
      method: 'onboarding.submit',
    });
  });
});
