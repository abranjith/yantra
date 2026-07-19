import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadSearchConfig } from '../../../src/extraction/search/config.js';
import { DEFAULT_SEARCH_CONFIG } from '../../../src/extraction/search/registry.js';

/**
 * End-to-end load path: `search.fetch_top` written to the real `config.yaml`
 * location must reach the loaded {@link SearchConfig}, and an out-of-range value
 * must fail loud at load time (the CLI maps this throw to a startup exit 1).
 * `configDir()` resolves via `APPDATA` (win32) or `XDG_CONFIG_HOME` (posix), so
 * we point both at a temp home to exercise the actual file read + validation.
 */

const dirs: string[] = [];
const savedEnv = { xdg: process.env.XDG_CONFIG_HOME, appdata: process.env.APPDATA };

afterEach(async () => {
  process.env.XDG_CONFIG_HOME = savedEnv.xdg;
  process.env.APPDATA = savedEnv.appdata;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function writeConfig(body: string): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'yantra-cfg-'));
  dirs.push(base);
  process.env.XDG_CONFIG_HOME = base;
  process.env.APPDATA = base;
  const dir = join(base, 'yantra');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'config.yaml'), body, 'utf8');
}

describe('@no-llm loadSearchConfig fetch_top wiring', () => {
  it('reads a configured search.fetch_top into the loaded config', async () => {
    await writeConfig('search:\n  provider: duckduckgo\n  fetch_top: 5\n');

    const config = await loadSearchConfig();

    expect(config.fetchTop).toBe(5);
    expect(config.provider).toBe('duckduckgo');
  });

  it('defaults fetch_top when the search block omits it', async () => {
    await writeConfig('search:\n  provider: auto\n');

    const config = await loadSearchConfig();

    expect(config.fetchTop).toBe(DEFAULT_SEARCH_CONFIG.fetchTop);
  });

  it('throws (fail-loud startup) on an out-of-range fetch_top', async () => {
    await writeConfig('search:\n  fetch_top: 6\n');

    await expect(loadSearchConfig()).rejects.toThrow(/fetch_top/i);
  });
});
