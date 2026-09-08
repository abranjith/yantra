import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resetPathCache } from '../../../src/config/resolved-paths.js';
import { loadSearchConfig } from '../../../src/extraction/search/config.js';
import { DEFAULT_SEARCH_CONFIG } from '../../../src/extraction/search/registry.js';

/**
 * End-to-end load path: `search.fetch_top` written to the real `config.yaml`
 * location must reach the loaded {@link SearchConfig}, and an out-of-range value
 * must fail loud at load time (the CLI maps this throw to a startup exit 1).
 * `configDir()` resolves to `YANTRA_HOME` on every platform, so we point it at
 * a temp home to exercise the actual file read + validation.
 */

const dirs: string[] = [];
const savedHome = process.env.YANTRA_HOME;

afterEach(async () => {
  if (savedHome === undefined) delete process.env.YANTRA_HOME;
  else process.env.YANTRA_HOME = savedHome;
  resetPathCache();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function writeConfig(body: string): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'yantra-cfg-'));
  dirs.push(base);
  process.env.YANTRA_HOME = base;
  resetPathCache();
  await mkdir(base, { recursive: true });
  await writeFile(join(base, 'config.yaml'), body, 'utf8');
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
