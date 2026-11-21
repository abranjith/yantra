// @no-llm
/**
 * FEAT-071 TASK-004 equivalence suite:
 * Terminal `yantra init` (scripted prompts) vs `onboarding.submit` (pre-answered collector)
 * produce byte-identical `config.yaml`, `profile.yaml`, and fake keychain contents.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  collectInitContextGrants,
  collectInitProviderAnswers,
  resetPathCache,
  runInit,
  type KeychainProvider,
} from '@yantra/core';
import type { InitAnswerScalar } from '@yantra/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { openHostLog } from '../../../src/ui/host/host-log.js';
import { AppHost } from '../../../src/ui/host/host.js';
import { registerOnboarding } from '../../../src/ui/host/onboarding.js';
import { RpcMethodRegistry, RpcServer } from '../../../src/ui/host/rpc-server.js';
import { SessionStore, sessionRoute } from '../../../src/ui/host/sessions.js';

import { connectAuthenticated } from './rpc-support.js';
import { cleanupTempDirs, makeTempDir, makeWebBuild, rawRequest } from './support.js';

interface EquivalenceCase {
  readonly name: string;
  readonly answers: Readonly<Record<string, InitAnswerScalar>>;
  readonly secrets: { readonly credential_secret?: string; readonly search_key_secret?: string };
  readonly reset?: boolean;
  readonly terminalSelects: readonly (string | null)[];
  readonly terminalTexts: readonly (string | null)[];
  readonly terminalPasswords: readonly (string | null)[];
  readonly terminalLocationConfirm: boolean;
  readonly terminalCityText: string | null;
}

const CASES: readonly EquivalenceCase[] = [
  {
    name: 'anthropic with an env ref',
    answers: {
      provider: 'anthropic',
      credential_source: 'environment variable',
      credential_env_name: 'MY_ANTHROPIC_KEY',
      model_id: 'claude-opus-4-7',
      search_key_provider: 'skip',
      data_dir: null,
      context_location: false,
    },
    secrets: {},
    terminalSelects: ['anthropic', 'environment variable', 'skip'],
    terminalTexts: ['MY_ANTHROPIC_KEY', 'claude-opus-4-7', ''],
    terminalPasswords: [],
    terminalLocationConfirm: false,
    terminalCityText: null,
  },
  {
    name: 'anthropic with a keychain secret',
    answers: {
      provider: 'anthropic',
      credential_source: 'keychain',
      model_id: 'claude-sonnet-4-5',
      search_key_provider: 'skip',
      data_dir: null,
      context_location: false,
    },
    secrets: { credential_secret: 'sk-ant-canary-123' },
    terminalSelects: ['anthropic', 'keychain', 'skip'],
    terminalTexts: ['claude-sonnet-4-5', ''],
    terminalPasswords: ['sk-ant-canary-123'],
    terminalLocationConfirm: false,
    terminalCityText: null,
  },
  {
    name: 'ollama with a custom base URL',
    answers: {
      provider: 'ollama',
      credential_source: 'skip',
      model_id: 'qwen2.5:14b',
      ollama_base_url: 'http://127.0.0.1:11435',
      search_key_provider: 'skip',
      data_dir: null,
      context_location: false,
    },
    secrets: {},
    terminalSelects: ['ollama', 'skip', 'skip'],
    terminalTexts: ['qwen2.5:14b', 'http://127.0.0.1:11435', ''],
    terminalPasswords: [],
    terminalLocationConfirm: false,
    terminalCityText: null,
  },
  {
    name: 'none plus a tavily search key',
    answers: {
      provider: 'none',
      search_key_provider: 'tavily',
      data_dir: null,
      context_location: false,
    },
    secrets: { search_key_secret: 'tvly-canary-456' },
    terminalSelects: ['none', 'tavily'],
    terminalTexts: [''],
    terminalPasswords: ['tvly-canary-456'],
    terminalLocationConfirm: false,
    terminalCityText: null,
  },
  {
    name: 'location declined',
    answers: {
      provider: 'none',
      search_key_provider: 'skip',
      data_dir: null,
      context_location: false,
    },
    secrets: {},
    terminalSelects: ['none', 'skip'],
    terminalTexts: [''],
    terminalPasswords: [],
    terminalLocationConfirm: false,
    terminalCityText: null,
  },
  {
    name: 'location granted with a city',
    answers: {
      provider: 'none',
      search_key_provider: 'skip',
      data_dir: null,
      context_location: true,
      context_city: 'Naperville, IL',
    },
    secrets: {},
    terminalSelects: ['none', 'skip'],
    terminalTexts: [''],
    terminalPasswords: [],
    terminalLocationConfirm: true,
    terminalCityText: 'Naperville, IL',
  },
  {
    name: 'location granted with a blank city',
    answers: {
      provider: 'none',
      search_key_provider: 'skip',
      data_dir: null,
      context_location: true,
      context_city: '',
    },
    secrets: {},
    terminalSelects: ['none', 'skip'],
    terminalTexts: [''],
    terminalPasswords: [],
    terminalLocationConfirm: true,
    terminalCityText: '',
  },
  {
    name: 'reset over an existing file',
    answers: {
      provider: 'none',
      search_key_provider: 'skip',
      data_dir: null,
      context_location: false,
    },
    secrets: {},
    reset: true,
    terminalSelects: ['none', 'skip'],
    terminalTexts: [''],
    terminalPasswords: [],
    terminalLocationConfirm: false,
    terminalCityText: null,
  },
];

function makeFakeKeychain(): KeychainProvider & { store: Map<string, string> } {
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

const extraHomes: string[] = [];

function makeHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'yantra-init-equiv-'));
  extraHomes.push(dir);
  return dir;
}

const originalYantraHome = process.env.YANTRA_HOME;

afterEach(() => {
  if (originalYantraHome === undefined) delete process.env.YANTRA_HOME;
  else process.env.YANTRA_HOME = originalYantraHome;
  resetPathCache();
  cleanupTempDirs();
  for (const dir of extraHomes.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('@no-llm onboarding.submit vs terminal init equivalence', () => {
  it.each(CASES)('produces byte-identical files and keychain for: $name', async (testCase) => {
    const terminalHome = makeHome();
    const appHome = makeHome();

    if (testCase.reset) {
      writeFileSync(join(terminalHome, 'config.yaml'), 'version: 1\nmodels: []\n', 'utf8');
      writeFileSync(join(appHome, 'config.yaml'), 'version: 1\nmodels: []\n', 'utf8');
    }

    // 1. Terminal path
    const terminalKeychain = makeFakeKeychain();
    process.env.YANTRA_HOME = terminalHome;
    resetPathCache();
    const selects = [...testCase.terminalSelects];
    const texts = [...testCase.terminalTexts];
    const passwords = [...testCase.terminalPasswords];
    const terminalResult = await runInit(
      { reset: testCase.reset === true, yes: false, interactive: true },
      {
        providerAnswers: () =>
          collectInitProviderAnswers({
            select: async () => selects.shift() ?? null,
            text: async () => texts.shift() ?? null,
            password: async () => passwords.shift() ?? null,
            keychain: async () => terminalKeychain,
          }),
        contextGrants: () =>
          collectInitContextGrants({
            confirm: async () => testCase.terminalLocationConfirm,
            text: async () => testCase.terminalCityText,
          }),
      },
      { lockOptions: { retries: 0 } },
    );
    expect(terminalResult.status).toBe('written');

    // 2. App host onboarding.submit path
    const appKeychain = makeFakeKeychain();
    process.env.YANTRA_HOME = appHome;
    resetPathCache();
    const log = openHostLog(join(makeTempDir(), 'host.log'));
    const sessions = new SessionStore();
    const methods = new RpcMethodRegistry();
    registerOnboarding(methods, {
      keychain: async () => appKeychain,
      lockOptions: { retries: 0 },
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
    try {
      const launch = sessions.issueLaunchCode().code;
      const response = await rawRequest(port, {
        method: 'POST',
        path: '/session',
        headers: { origin: `http://127.0.0.1:${port}` },
        body: JSON.stringify({ code: launch }),
      });
      const grant = JSON.parse(response.body.toString()) as { window_capability: string };
      const cookie = (response.headers['set-cookie']?.[0] ?? '').split(';')[0]!.split('=')[1]!;
      const socket = await connectAuthenticated(port, cookie, grant.window_capability);

      const submitReply = await socket.call('onboarding.submit', {
        answers: testCase.answers,
        secrets: testCase.secrets,
        reset: testCase.reset === true,
        invocation_id: `equiv-${testCase.name}`,
      });
      expect(submitReply.error).toBeUndefined();
      expect((submitReply.result as { status: string }).status).toBe('written');
    } finally {
      rpc.close();
      await host.stop();
    }

    // 3. Byte-identical comparison
    expect(readFileSync(join(appHome, 'config.yaml'), 'utf8')).toBe(
      readFileSync(join(terminalHome, 'config.yaml'), 'utf8'),
    );
    expect(readFileSync(join(appHome, 'profile.yaml'), 'utf8')).toBe(
      readFileSync(join(terminalHome, 'profile.yaml'), 'utf8'),
    );
    expect([...appKeychain.store.entries()]).toEqual([...terminalKeychain.store.entries()]);

    if (testCase.reset) {
      const terminalBackups = readdirSync(terminalHome).filter((f) =>
        f.startsWith('config.yaml.bak.'),
      );
      const appBackups = readdirSync(appHome).filter((f) => f.startsWith('config.yaml.bak.'));
      expect(terminalBackups).toHaveLength(1);
      expect(appBackups).toHaveLength(1);
      expect(readFileSync(join(appHome, appBackups[0]!), 'utf8')).toBe(
        readFileSync(join(terminalHome, terminalBackups[0]!), 'utf8'),
      );
    }
  });
});
