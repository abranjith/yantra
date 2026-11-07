import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';

import { withResourceLock, ResourceBusyError } from '../../src/locks/resource-lock.js';
import {
  collectInitProviderAnswers,
  defaultContextGrantAnswers,
  defaultsFor,
  runInit,
  type InitAnswerCollector,
  type InitAnswers,
} from '../../src/setup/init-service.js';
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'yantra-init-service-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const providers = ['anthropic', 'ollama', 'none'] as const;
const cases = providers.flatMap((provider) =>
  [false, true].flatMap((custom) =>
    [false, true].flatMap((granted) =>
      ['stored', 'manual', 'skipped'].map((search) => ({ provider, custom, granted, search })),
    ),
  ),
);
const dependencies = () => ({
  configPath: join(root, 'config.yaml'),
  profilePath: join(root, 'profile.yaml'),
  lockOptions: { retries: 0 },
});
function collector(answers: InitAnswers): InitAnswerCollector {
  return {
    providerAnswers: async () => answers,
    contextGrants: async () => defaultContextGrantAnswers(),
  };
}
const request = { reset: false, yes: false, interactive: true };
describe('@no-llm shared init service', () => {
  it.each(cases)(
    'retains baseline bytes for $provider custom=$custom grant=$granted key=$search',
    async ({ provider, custom, granted, search }) => {
      const selections = [
        provider,
        ...(provider === 'none'
          ? []
          : [provider === 'anthropic' ? 'environment variable' : 'skip']),
        search === 'skipped' ? 'skip' : 'tavily',
      ];
      const data = custom ? join(root, 'custom-data') : null;
      const stored = new Map<string, string>();
      const keychain = {
        isAvailable: async () => search !== 'manual',
        set: async (_service: string, account: string, value: string) => {
          stored.set(account, value);
        },
        get: async () => null,
        delete: async () => false,
        list: async () => [],
      };
      const answers: InitAnswerCollector = {
        providerAnswers: () =>
          collectInitProviderAnswers({
            select: async () => selections.shift() ?? null,
            text: async (message) => (message.startsWith('Data directory') ? data : ''),
            password: async () => 'CANARY-init-key',
            keychain: async () => keychain,
          }),
        contextGrants: async () => ({
          grants: { location: granted, screenshots: false },
          city: granted ? 'Fixture City' : null,
        }),
      };
      const result = await runInit(request, answers, dependencies());
      expect(result.status).toBe('written');
      const baseline = JSON.parse(
        await readFile(
          new URL(
            `../../../../apps/cli/tests/characterization/baselines/init.${provider === 'none' ? 'defaults' : provider}.json`,
            import.meta.url,
          ),
          'utf8',
        ),
      ) as { tree: Record<string, string> };
      let config = baseline.tree['config.yaml']!;
      if (data)
        config = config.replace('  data_dir: null', `  data_dir: ${stringify(data).trim()}`);
      const profile = baseline.tree['profile.yaml']!.replace(
        '  location: true',
        `  location: ${granted}`,
      ).replace('  city: null', granted ? '  city: Fixture City' : '  city: null');
      const actualConfig = await readFile(dependencies().configPath, 'utf8'),
        actualProfile = await readFile(dependencies().profilePath, 'utf8');
      expect(actualConfig).toBe(config);
      expect(actualProfile).toBe(profile);
      expect(actualConfig + actualProfile + JSON.stringify(result)).not.toContain(
        'CANARY-init-key',
      );
      expect(stored.get('tavily.api_key')).toBe(
        search === 'stored' ? 'CANARY-init-key' : undefined,
      );
      if (result.status === 'written') expect(result.searchKey.status).toBe(search);
      if (data) expect((await stat(data)).isDirectory()).toBe(true);
    },
  );
  it('backs up exact prior bytes on reset and leaves an existing setup untouched otherwise', async () => {
    const c = collector(defaultsFor('none'));
    await runInit(request, c, dependencies());
    const original = await readFile(dependencies().configPath, 'utf8');
    const collect = vi.fn(c.providerAnswers);
    expect(
      (await runInit(request, { ...c, providerAnswers: collect }, dependencies())).status,
    ).toBe('already-initialized');
    expect(collect).not.toHaveBeenCalled();
    expect(
      (await runInit({ ...request, reset: true }, c, { ...dependencies(), now: () => 123 })).status,
    ).toBe('written');
    expect(await readFile(join(root, 'config.yaml.bak.123'), 'utf8')).toBe(original);
  });
  it('rejects invalid providers and relative data directories without publishing files', async () => {
    expect(
      (
        await runInit(
          { ...request, provider: 'invalid' },
          collector(defaultsFor('none')),
          dependencies(),
        )
      ).status,
    ).toBe('invalid-provider');
    expect(
      await runInit(
        request,
        collector({ ...defaultsFor('none'), dataDir: 'relative' }),
        dependencies(),
      ),
    ).toEqual({ status: 'failed', message: 'the data directory must be absolute' });
    expect(await readdir(root)).toEqual([]);
  });
  it('surfaces config contention and retains the original document', async () => {
    const path = dependencies().configPath;
    await writeFile(path, '# original\n');
    await withResourceLock(
      { kind: 'config' },
      async () => {
        await expect(
          runInit({ ...request, reset: true }, collector(defaultsFor('none')), dependencies()),
        ).rejects.toBeInstanceOf(ResourceBusyError);
        expect(await readFile(path, 'utf8')).toBe('# original\n');
      },
      { targetPath: path },
    );
  });
});
