/**
 * @no-llm Environment isolation tests for the pinned Pi runtime (plan §8.11).
 *
 * These tests are the enforcement mechanism for the security acceptance
 * criteria: pinned paths under the Yantra data dir, zero ambient resources,
 * in-memory settings, opt-in personal auth, and runtime keys that never
 * touch disk.
 */

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import { AuthStorage } from '@earendil-works/pi-coding-agent';
import type { KeychainProvider } from '@yantra/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  checkCustomModelContextWindow,
  createPiEnvironment,
  probePiCredential,
  type PiEnvironmentOptions,
} from '../../../src/adapters/pi/environment.js';
import { AgentAuthUnavailableError } from '../../../src/errors.js';

const SYSTEM_PROMPT = 'agent-v1: use only registered Yantra tools.';

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function baseOptions(
  overrides: Partial<PiEnvironmentOptions> = {},
): Promise<PiEnvironmentOptions> {
  const dataDir = await makeTempDir('yantra-env-data-');
  const cwd = await makeTempDir('yantra-env-cwd-');
  return {
    cwd,
    systemPrompt: SYSTEM_PROMPT,
    provider: 'testprov',
    auth: { mode: 'managed' },
    dataDir,
    ...overrides,
  };
}

/** Recursively collect every file under a directory. */
async function collectFiles(root: string, collected: string[] = []): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return collected;
  }
  for (const entry of entries) {
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(fullPath, collected);
    } else if (entry.isFile()) {
      collected.push(fullPath);
    }
  }
  return collected;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true }).catch(() => undefined)),
  );
});

describe('@no-llm createPiEnvironment — pinned paths', () => {
  it('constructs every path under the injected Yantra data directory', async () => {
    const options = await baseOptions();
    const env = await createPiEnvironment(options);

    const dataDir = options.dataDir ?? '';
    expect(env.agentDir).toBe(join(dataDir, 'pi'));
    for (const path of [env.authPath, env.modelsPath, env.sessionStagingDir]) {
      expect(path.startsWith(env.agentDir + sep)).toBe(true);
    }

    const enumeration = env.enumerate();
    expect(enumeration.agentDir).toBe(env.agentDir);
    expect(enumeration.settingsSource).toBe('in-memory');
  });

  it('never consults planted pi settings files (global agentDir or project .pi)', async () => {
    const options = await baseOptions();

    // Plant a poisoned "global" settings.json inside the pinned agentDir and a
    // poisoned project .pi/settings.json in cwd. A default (file-backed) Pi
    // setup would read both; the in-memory manager must read neither.
    const agentDir = join(options.dataDir ?? '', 'pi');
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      join(agentDir, 'settings.json'),
      JSON.stringify({
        defaultModel: 'poisoned-global-model',
        extensions: ['/poison/global-extension.js'],
      }),
      'utf8',
    );
    await mkdir(join(options.cwd, '.pi'), { recursive: true });
    await writeFile(
      join(options.cwd, '.pi', 'settings.json'),
      JSON.stringify({
        defaultModel: 'poisoned-project-model',
        skills: ['/poison/project-skill'],
      }),
      'utf8',
    );

    const env = await createPiEnvironment(options);

    const effective = {
      ...env.settingsManager.getGlobalSettings(),
      ...env.settingsManager.getProjectSettings(),
    };
    expect(JSON.stringify(effective)).not.toContain('poisoned');
    expect(env.settingsManager.getExtensionPaths()).toEqual([]);
    expect(env.settingsManager.getSkillPaths()).toEqual([]);

    const enumeration = env.enumerate();
    expect(enumeration.extensions).toEqual([]);
    expect(enumeration.skills).toEqual([]);
  });
});

describe('@no-llm createPiEnvironment — controlled resources', () => {
  it('yields exactly the supplied system prompt and zero ambient resources', async () => {
    const options = await baseOptions();

    // Plant ambient resources a default loader could discover.
    await writeFile(join(options.cwd, 'AGENTS.md'), '# poisoned agents context', 'utf8');
    await writeFile(join(options.cwd, 'CLAUDE.md'), '# poisoned claude context', 'utf8');
    await mkdir(join(options.cwd, '.pi', 'extensions'), { recursive: true });
    await writeFile(
      join(options.cwd, '.pi', 'extensions', 'poison.js'),
      'export default () => {};',
      'utf8',
    );

    const env = await createPiEnvironment(options);
    const enumeration = env.enumerate();

    expect(enumeration.systemPrompt).toBe(SYSTEM_PROMPT);
    expect(enumeration.appendSystemPrompt).toEqual([]);
    expect(enumeration.extensions).toEqual([]);
    expect(enumeration.skills).toEqual([]);
    expect(enumeration.prompts).toEqual([]);
    expect(enumeration.themes).toEqual([]);
    expect(enumeration.contextFiles).toEqual([]);
  });
});

describe('@no-llm createPiEnvironment — auth', () => {
  it('the personal-store opt-in switches only the auth path', async () => {
    const options = await baseOptions();
    const personalDir = await makeTempDir('yantra-env-personal-');
    const personalPiAuthPath = join(personalDir, 'auth.json');
    await writeFile(personalPiAuthPath, '{}', 'utf8');

    const pinned = await createPiEnvironment(options);
    const optedIn = await createPiEnvironment({ ...options, personalPiAuthPath });

    expect(optedIn.authPath).toBe(personalPiAuthPath);
    expect(optedIn.agentDir).toBe(pinned.agentDir);
    expect(optedIn.modelsPath).toBe(pinned.modelsPath);
    expect(optedIn.sessionStagingDir).toBe(pinned.sessionStagingDir);
  });

  it('runtime-key resolves the secret in memory and never writes it to disk', async () => {
    const canary = 'sk-canary-9f83b2e1d4c5a6b7';
    const options = await baseOptions({
      auth: { mode: 'runtime-key', secretRef: 'anthropic/api-key' },
      resolveSecret: (ref) => {
        expect(ref).toBe('anthropic/api-key');
        return Promise.resolve(canary);
      },
    });

    const env = await createPiEnvironment(options);
    expect(env.authSource).toBe('runtime-key');

    // Canary scan: no file anywhere under the data dir may contain the value.
    const files = await collectFiles(options.dataDir ?? '');
    const leakedInto: string[] = [];
    for (const file of files) {
      const content = await readFile(file, 'utf8').catch(() => '');
      if (content.includes(canary)) {
        leakedInto.push(file);
      }
    }
    expect(leakedInto).toEqual([]);
  });

  it('runtime-key without a configured resolver is a typed AGENT_AUTH_UNAVAILABLE failure', async () => {
    const options = await baseOptions({
      auth: { mode: 'runtime-key', secretRef: 'anthropic/api-key' },
    });

    const attempt = createPiEnvironment(options);
    await expect(attempt).rejects.toBeInstanceOf(AgentAuthUnavailableError);
    await expect(attempt).rejects.toMatchObject({ code: 'AGENT_AUTH_UNAVAILABLE' });
  });

  it('runtime-key whose secret reference fails to resolve is typed and names the source tried', async () => {
    const options = await baseOptions({
      auth: { mode: 'runtime-key', secretRef: 'missing/ref' },
      resolveSecret: () => Promise.reject(new Error('keychain entry not found')),
    });

    await expect(createPiEnvironment(options)).rejects.toMatchObject({
      code: 'AGENT_AUTH_UNAVAILABLE',
      message: expect.stringContaining('missing/ref') as unknown,
    });
  });

  it('reports environment-variable credentials as auth source "environment"', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-env-var-key-for-test');
    const options = await baseOptions({ provider: 'anthropic' });

    const env = await createPiEnvironment(options);
    expect(env.authSource).toBe('environment');
  });

  it('reports no credentials as auth source "unavailable"', async () => {
    const options = await baseOptions({ provider: 'testprov' });

    const env = await createPiEnvironment(options);
    expect(env.authSource).toBe('unavailable');
  });
});

describe('@no-llm probePiCredential', () => {
  function keychain(list: KeychainProvider['list']): KeychainProvider {
    return {
      get: () => Promise.resolve(null),
      set: () => Promise.resolve(),
      delete: () => Promise.resolve(false),
      list,
      isAvailable: () => Promise.resolve(true),
    };
  }

  it('finds a provider environment credential without opening a session', async () => {
    await expect(
      probePiCredential({
        provider: 'anthropic',
        auth: { mode: 'managed' },
        env: { ANTHROPIC_API_KEY: 'fixture' },
        dataDir: await makeTempDir('yantra-probe-env-'),
      }),
    ).resolves.toEqual({ available: true, authSource: 'environment' });
  });

  it('finds a managed auth.json credential by status only', async () => {
    const dataDir = await makeTempDir('yantra-probe-managed-');
    const authPath = join(dataDir, 'pi', 'auth.json');
    AuthStorage.create(authPath).set('testprov', { type: 'api_key', key: 'fixture' });

    await expect(
      probePiCredential({
        provider: 'testprov',
        auth: { mode: 'managed' },
        env: {},
        dataDir,
      }),
    ).resolves.toEqual({ available: true, authSource: 'managed' });
  });

  it('finds a runtime-key reference by account name without reading its value', async () => {
    let getCalled = false;
    const store: KeychainProvider = {
      get: () => {
        getCalled = true;
        return Promise.resolve('must-not-be-read');
      },
      set: () => Promise.resolve(),
      delete: () => Promise.resolve(false),
      list: () => Promise.resolve([{ account: 'model.api_key' }]),
      isAvailable: () => Promise.resolve(true),
    };

    await expect(
      probePiCredential({
        provider: 'anthropic',
        auth: { mode: 'runtime-key', secretRef: 'model.api_key' },
        env: {},
        keychain: store,
      }),
    ).resolves.toEqual({ available: true, authSource: 'runtime-key' });
    expect(getCalled).toBe(false);
  });

  it('turns an unreadable keychain into unavailable instead of throwing', async () => {
    await expect(
      probePiCredential({
        provider: 'anthropic',
        auth: { mode: 'runtime-key', secretRef: 'model.api_key' },
        env: {},
        keychain: keychain(() => Promise.reject(new Error('locked'))),
      }),
    ).resolves.toEqual({ available: false, authSource: 'unavailable' });
  });
});

describe('@no-llm checkCustomModelContextWindow — models.json declaration check', () => {
  async function writeModels(content: unknown): Promise<string> {
    const dir = await makeTempDir('yantra-env-models-');
    const modelsPath = join(dir, 'models.json');
    await writeFile(modelsPath, JSON.stringify(content), 'utf8');
    return modelsPath;
  }

  it('reports "undeclared" for a custom model without contextWindow (the gemma/ollama truncation setup)', async () => {
    const modelsPath = await writeModels({
      providers: {
        ollama: {
          baseUrl: 'http://127.0.0.1:11434/v1',
          api: 'openai-completions',
          apiKey: 'ollama',
          models: [{ id: 'gemma4:e4b' }],
        },
      },
    });

    await expect(
      checkCustomModelContextWindow(modelsPath, 'ollama', 'gemma4:e4b'),
    ).resolves.toEqual({ kind: 'undeclared' });
  });

  it('reports the declared window when the model declares contextWindow', async () => {
    const modelsPath = await writeModels({
      providers: {
        ollama: { models: [{ id: 'gemma4:e4b', contextWindow: 16384 }] },
      },
    });

    await expect(
      checkCustomModelContextWindow(modelsPath, 'ollama', 'gemma4:e4b'),
    ).resolves.toEqual({ kind: 'declared', contextWindow: 16384 });
  });

  it('treats a non-positive or non-numeric contextWindow as undeclared', async () => {
    const modelsPath = await writeModels({
      providers: {
        ollama: {
          models: [
            { id: 'a', contextWindow: 0 },
            { id: 'b', contextWindow: '8k' },
          ],
        },
      },
    });

    await expect(checkCustomModelContextWindow(modelsPath, 'ollama', 'a')).resolves.toEqual({
      kind: 'undeclared',
    });
    await expect(checkCustomModelContextWindow(modelsPath, 'ollama', 'b')).resolves.toEqual({
      kind: 'undeclared',
    });
  });

  it('reports "not-custom" when the provider or model is not in models.json', async () => {
    const modelsPath = await writeModels({
      providers: { ollama: { models: [{ id: 'gemma4:e4b' }] } },
    });

    await expect(
      checkCustomModelContextWindow(modelsPath, 'anthropic', 'claude-haiku-4-5'),
    ).resolves.toEqual({ kind: 'not-custom' });
    await expect(
      checkCustomModelContextWindow(modelsPath, 'ollama', 'other-model'),
    ).resolves.toEqual({ kind: 'not-custom' });
  });

  it('reports "not-custom" for a missing or malformed models.json', async () => {
    const dir = await makeTempDir('yantra-env-models-missing-');
    await expect(
      checkCustomModelContextWindow(join(dir, 'models.json'), 'ollama', 'gemma4:e4b'),
    ).resolves.toEqual({ kind: 'not-custom' });

    const malformedPath = join(dir, 'malformed.json');
    await writeFile(malformedPath, '{not json', 'utf8');
    await expect(
      checkCustomModelContextWindow(malformedPath, 'ollama', 'gemma4:e4b'),
    ).resolves.toEqual({ kind: 'not-custom' });
  });
});
