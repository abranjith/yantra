import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SanitizationProfileError } from '../../src/sanitizer/errors.js';
import {
  DEFAULT_HOST_OVERRIDES,
  FileHostOverrideStore,
} from '../../src/sanitizer/host-overrides.js';

describe('@no-llm host override store', () => {
  let defaultRoot: string | undefined;
  const savedHome = process.env.YANTRA_HOME;

  afterEach(async () => {
    if (savedHome === undefined) delete process.env.YANTRA_HOME;
    else process.env.YANTRA_HOME = savedHome;
    if (defaultRoot) await rm(defaultRoot, { recursive: true, force: true });
  });

  it('loads the default user path from YANTRA_HOME/sanitizer-hosts.yaml', async () => {
    defaultRoot = await mkdtemp(join(tmpdir(), 'yantra-host-overrides-home-'));
    process.env.YANTRA_HOME = defaultRoot;
    await writeFile(
      join(defaultRoot, 'sanitizer-hosts.yaml'),
      'version: 1\nhosts:\n  "*.home.example":\n    inherits: authenticated\n    extra_redactors: [case_number]\n',
    );
    const store = new FileHostOverrideStore();
    await store.load();
    expect(store.match('secure.home.example')?.extraRedactors).toEqual(['case_number']);
  });

  it('falls back to packaged defaults when user file is absent', async () => {
    const impossiblePath = join(tmpdir(), `yantra-missing-${Date.now()}`, 'sanitizer-hosts.yaml');
    const store = new FileHostOverrideStore(impossiblePath);

    const loaded = await store.load();

    expect(loaded.length).toBe(DEFAULT_HOST_OVERRIDES.length);
    expect(store.match('secure.chase.com')?.hostPattern).toBe('*.chase.com');
  });

  it('loads host overrides from a user file and matches by glob', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yantra-host-overrides-'));
    const filePath = join(root, 'sanitizer-hosts.yaml');

    await writeFile(
      filePath,
      [
        'version: 1',
        'hosts:',
        '  "*.example.com":',
        '    inherits: authenticated',
        '    extra_redactors:',
        '      - case_number',
      ].join('\n'),
      'utf8',
    );

    const store = new FileHostOverrideStore(filePath);
    const loaded = await store.load();

    expect(loaded).toHaveLength(1);
    expect(store.match('api.example.com')?.extraRedactors).toEqual(['case_number']);

    await rm(root, { recursive: true, force: true });
  });

  it('throws on malformed override YAML', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yantra-host-overrides-bad-'));
    const filePath = join(root, 'sanitizer-hosts.yaml');

    await writeFile(
      filePath,
      ['version: 1', 'hosts:', '  bad:', '    inherits: nope'].join('\n'),
      'utf8',
    );

    const store = new FileHostOverrideStore(filePath);
    await expect(store.load()).rejects.toBeInstanceOf(SanitizationProfileError);

    await rm(root, { recursive: true, force: true });
  });

  it('reload picks up file changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yantra-host-overrides-reload-'));
    const filePath = join(root, 'sanitizer-hosts.yaml');

    const store = new FileHostOverrideStore(filePath);

    await writeFile(
      filePath,
      [
        'version: 1',
        'hosts:',
        '  "*.example.org":',
        '    inherits: authenticated',
        '    extra_redactors: [currency_usd]',
      ].join('\n'),
      'utf8',
    );
    await store.load();
    expect(store.match('secure.example.org')?.extraRedactors).toEqual(['currency_usd']);

    await writeFile(
      filePath,
      [
        'version: 1',
        'hosts:',
        '  "*.example.org":',
        '    inherits: authenticated',
        '    extra_redactors: [date_of_birth]',
      ].join('\n'),
      'utf8',
    );
    await store.reload();

    expect(store.match('secure.example.org')?.extraRedactors).toEqual(['date_of_birth']);

    await rm(root, { recursive: true, force: true });
  });
});
