// @no-llm
/**
 * FEAT-071 TASK-004 host onboarding RPC (`read.onboarding_status`, `onboarding.submit`):
 * - status reporting,
 * - validation before side effects,
 * - error mapping (missing_answer, invalid_answer, already_initialized,
 *   relocation_requires_terminal, busy, keychain_unavailable),
 * - sequential and concurrent invocation_id idempotency,
 * - zero child_process/worker spawns,
 * - canary and free-text absence from responses, errors, and host.log.
 */

import childProcess from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  resetPathCache,
  withResourceLock,
  writeConfigDocument,
  type KeychainProvider,
} from '@yantra/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { openHostLog } from '../../../src/ui/host/host-log.js';
import { AppHost } from '../../../src/ui/host/host.js';
import { D15_RELOCATION_STEPS, registerOnboarding } from '../../../src/ui/host/onboarding.js';
import { RpcMethodRegistry, RpcServer } from '../../../src/ui/host/rpc-server.js';
import { SessionStore, sessionRoute } from '../../../src/ui/host/sessions.js';
import * as workerSpawn from '../../../src/worker/spawn.js';

import { connectAuthenticated } from './rpc-support.js';
import { cleanupTempDirs, makeTempDir, makeWebBuild, rawRequest } from './support.js';

const SECRET_CANARY = 'CANARY_ONBOARDING_SECRET_7731';
const CITY_CANARY = 'CANARY_FREE_TEXT_CITY_8842';

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

const originalYantraHome = process.env.YANTRA_HOME;

async function startOnboardingHost(options: {
  readonly home: string;
  readonly keychain: KeychainProvider;
  readonly logPath?: string;
  readonly writeConfig?: typeof writeConfigDocument;
  readonly onSuccess?: () => void;
}) {
  process.env.YANTRA_HOME = options.home;
  resetPathCache();

  const logPath = options.logPath ?? join(makeTempDir(), 'host.log');
  const log = openHostLog(logPath);
  const sessions = new SessionStore();
  const methods = new RpcMethodRegistry();
  registerOnboarding(methods, {
    keychain: async () => options.keychain,
    lockOptions: { retries: 0 },
    logger: log.logger,
    ...(options.writeConfig ? { writeConfig: options.writeConfig } : {}),
    ...(options.onSuccess ? { onSuccess: options.onSuccess } : {}),
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
    logPath,
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
  if (originalYantraHome === undefined) delete process.env.YANTRA_HOME;
  else process.env.YANTRA_HOME = originalYantraHome;
  resetPathCache();
  cleanupTempDirs();
});

describe('@no-llm host onboarding RPC', () => {
  it('reports read.onboarding_status accurately before and after initialization', async () => {
    const home = makeTempDir();
    const keychain = makeFakeKeychain(true);
    const server = await startOnboardingHost({ home, keychain });
    try {
      const socket = await server.openSocket();
      const before = await socket.call('read.onboarding_status', {});
      expect(before.error).toBeUndefined();
      expect(before.result).toEqual({
        config_exists: false,
        profile_exists: false,
        config_path: join(home, 'config.yaml'),
        profile_path: join(home, 'profile.yaml'),
        data_dir: {
          effective: join(home, 'data'),
          source: 'default',
          configured: null,
        },
        keychain_available: true,
      });

      const submit = await socket.call('onboarding.submit', {
        answers: {
          provider: 'none',
          search_key_provider: 'skip',
          data_dir: null,
          context_location: false,
        },
        secrets: {},
        reset: false,
        invocation_id: 'status-check-1',
      });
      expect(submit.error).toBeUndefined();

      const after = await socket.call('read.onboarding_status', {});
      expect(after.result).toMatchObject({
        config_exists: true,
        profile_exists: true,
        data_dir: { configured: null },
      });
    } finally {
      await server.stop();
    }
  });

  it('returns missing_answer when model_id is absent for anthropic without side effects', async () => {
    const home = makeTempDir();
    const keychain = makeFakeKeychain(true);
    const server = await startOnboardingHost({ home, keychain });
    try {
      const socket = await server.openSocket();
      const reply = await socket.call('onboarding.submit', {
        answers: {
          provider: 'anthropic',
          credential_source: 'keychain',
          search_key_provider: 'skip',
          data_dir: null,
          context_location: false,
        },
        secrets: { credential_secret: SECRET_CANARY },
        reset: false,
        invocation_id: 'missing-model-id',
      });
      expect((reply.error as { data: { code: string } }).data.code).toBe('missing_answer');
      expect(keychain.store.size).toBe(0);
      expect(existsSync(join(home, 'config.yaml'))).toBe(false);
      expect(JSON.stringify(reply)).not.toContain(SECRET_CANARY);
      server.log.flush();
      expect(readFileSync(server.logPath, 'utf8')).not.toContain(SECRET_CANARY);
    } finally {
      await server.stop();
    }
  });

  it('returns invalid_answer for an unknown provider without logging free text', async () => {
    const home = makeTempDir();
    const keychain = makeFakeKeychain(true);
    const server = await startOnboardingHost({ home, keychain });
    try {
      const socket = await server.openSocket();
      const reply = await socket.call('onboarding.submit', {
        answers: {
          provider: 'BOGUS_FREE_TEXT_PROVIDER',
          search_key_provider: 'skip',
          data_dir: null,
          context_location: true,
          context_city: CITY_CANARY,
        },
        secrets: {},
        reset: false,
        invocation_id: 'invalid-provider',
      });
      expect((reply.error as { data: { code: string } }).data.code).toBe('invalid_answer');
      expect(JSON.stringify(reply)).not.toContain('BOGUS_FREE_TEXT_PROVIDER');
      expect(JSON.stringify(reply)).not.toContain(CITY_CANARY);
      server.log.flush();
      const logContent = readFileSync(server.logPath, 'utf8');
      expect(logContent).not.toContain('BOGUS_FREE_TEXT_PROVIDER');
      expect(logContent).not.toContain(CITY_CANARY);
    } finally {
      await server.stop();
    }
  });

  it('returns already_initialized when config.yaml exists and reset is false', async () => {
    const home = makeTempDir();
    writeFileSync(join(home, 'config.yaml'), 'version: 1\nmodels: []\n', 'utf8');
    const keychain = makeFakeKeychain(true);
    const server = await startOnboardingHost({ home, keychain });
    try {
      const socket = await server.openSocket();
      const reply = await socket.call('onboarding.submit', {
        answers: {
          provider: 'none',
          search_key_provider: 'skip',
          data_dir: null,
          context_location: false,
        },
        secrets: {},
        reset: false,
        invocation_id: 'already-init',
      });
      expect((reply.error as { data: { code: string } }).data.code).toBe('already_initialized');
    } finally {
      await server.stop();
    }
  });

  it('returns relocation_requires_terminal with D15 steps when data_dir differs and writes nothing', async () => {
    const home = makeTempDir();
    const keychain = makeFakeKeychain(true);
    const server = await startOnboardingHost({ home, keychain });
    try {
      const socket = await server.openSocket();
      const reply = await socket.call('onboarding.submit', {
        answers: {
          provider: 'none',
          search_key_provider: 'skip',
          data_dir: join(home, 'other-data'),
          context_location: false,
        },
        secrets: {},
        reset: false,
        invocation_id: 'relocate-1',
      });
      const data = (reply.error as { data: { code: string; remediation: string } }).data;
      expect(data.code).toBe('relocation_requires_terminal');
      for (const step of D15_RELOCATION_STEPS) {
        expect(data.remediation).toContain(step);
      }
      expect(existsSync(join(home, 'config.yaml'))).toBe(false);
    } finally {
      await server.stop();
    }
  });

  it('returns busy when the config lock is held and writes nothing', async () => {
    const home = makeTempDir();
    const cfgPath = join(home, 'config.yaml');
    writeFileSync(cfgPath, 'version: 1\nmodels: []\n', 'utf8');
    const keychain = makeFakeKeychain(true);
    const server = await startOnboardingHost({ home, keychain });
    try {
      const socket = await server.openSocket();
      await withResourceLock(
        { kind: 'config' },
        async () => {
          const reply = await socket.call('onboarding.submit', {
            answers: {
              provider: 'none',
              search_key_provider: 'skip',
              data_dir: null,
              context_location: false,
            },
            secrets: {},
            reset: true,
            invocation_id: 'busy-1',
          });
          expect((reply.error as { data: { code: string } }).data.code).toBe('busy');
          expect(readFileSync(cfgPath, 'utf8')).toBe('version: 1\nmodels: []\n');
        },
        { targetPath: cfgPath },
      );
    } finally {
      await server.stop();
    }
  });

  it('maps unavailable keychain on credential_secret to keychain_unavailable and on search_key_secret to manual', async () => {
    const home1 = makeTempDir();
    const unavailable1 = makeFakeKeychain(false);
    const server1 = await startOnboardingHost({ home: home1, keychain: unavailable1 });
    try {
      const socket = await server1.openSocket();
      const reply = await socket.call('onboarding.submit', {
        answers: {
          provider: 'anthropic',
          credential_source: 'keychain',
          model_id: 'claude-opus-4-7',
          search_key_provider: 'skip',
          data_dir: null,
          context_location: false,
        },
        secrets: { credential_secret: SECRET_CANARY },
        reset: false,
        invocation_id: 'kc-unavail-model',
      });
      expect((reply.error as { data: { code: string } }).data.code).toBe('keychain_unavailable');
      expect(JSON.stringify(reply)).not.toContain(SECRET_CANARY);
      expect(existsSync(join(home1, 'config.yaml'))).toBe(false);
    } finally {
      await server1.stop();
    }

    const home2 = makeTempDir();
    const unavailable2 = makeFakeKeychain(false);
    const server2 = await startOnboardingHost({ home: home2, keychain: unavailable2 });
    try {
      const socket = await server2.openSocket();
      const reply = await socket.call('onboarding.submit', {
        answers: {
          provider: 'none',
          search_key_provider: 'tavily',
          data_dir: null,
          context_location: false,
        },
        secrets: { search_key_secret: SECRET_CANARY },
        reset: false,
        invocation_id: 'kc-unavail-search',
      });
      expect(reply.error).toBeUndefined();
      expect(reply.result).toMatchObject({
        status: 'written',
        search_key: 'manual',
        command: 'yantra secret set tavily.api_key',
      });
      expect(JSON.stringify(reply)).not.toContain(SECRET_CANARY);
    } finally {
      await server2.stop();
    }
  });

  it('is idempotent for sequential and concurrent identical invocation_id, never logs secrets or city, and never spawns', async () => {
    const home = makeTempDir();
    const keychain = makeFakeKeychain(true);
    const writeHolder = { writeConfig: writeConfigDocument };
    const writeSpy = vi.spyOn(writeHolder, 'writeConfig');
    const spawnSpy = vi.spyOn(childProcess, 'spawn');
    const workerSpy = vi.spyOn(workerSpawn, 'spawnDetachedWorker');
    const onSuccess = vi.fn();

    const server = await startOnboardingHost({
      home,
      keychain,
      writeConfig: (...args) => writeHolder.writeConfig(...args),
      onSuccess,
    });
    try {
      const socket = await server.openSocket();
      const payload = {
        answers: {
          provider: 'anthropic',
          credential_source: 'keychain',
          model_id: 'claude-opus-4-7',
          search_key_provider: 'skip',
          data_dir: null,
          context_location: true,
          context_city: CITY_CANARY,
        },
        secrets: { credential_secret: SECRET_CANARY },
        reset: false,
        invocation_id: 'idem-1',
      };

      // Concurrent identical submits
      const [r1, r2] = await Promise.all([
        socket.call('onboarding.submit', payload),
        socket.call('onboarding.submit', payload),
      ]);
      // Sequential repeat
      const r3 = await socket.call('onboarding.submit', payload);

      expect(r1.error).toBeUndefined();
      expect(r1.result).toEqual(r2.result);
      expect(r1.result).toEqual(r3.result);
      expect(writeSpy).toHaveBeenCalledTimes(1);
      expect(onSuccess).toHaveBeenCalledTimes(1);
      expect(spawnSpy).not.toHaveBeenCalled();
      expect(workerSpy).not.toHaveBeenCalled();

      expect(JSON.stringify([r1, r2, r3])).not.toContain(SECRET_CANARY);
      expect(JSON.stringify([r1, r2, r3])).not.toContain(CITY_CANARY);
      server.log.flush();
      const logContent = readFileSync(server.logPath, 'utf8');
      expect(logContent).not.toContain(SECRET_CANARY);
      expect(logContent).not.toContain(CITY_CANARY);
      expect(logContent).toContain('onboarding_submitted');
    } finally {
      await server.stop();
    }
  });
});
