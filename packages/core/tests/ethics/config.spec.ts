import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadEthicsConfig } from '../../src/ethics/config.js';

describe('@no-llm ethics configuration path', () => {
  let root: string | undefined;
  const savedHome = process.env.YANTRA_HOME;

  afterEach(async () => {
    if (savedHome === undefined) delete process.env.YANTRA_HOME;
    else process.env.YANTRA_HOME = savedHome;
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('loads robots and rate-limit settings from YANTRA_HOME/config.yaml', async () => {
    root = await mkdtemp(join(tmpdir(), 'yantra-ethics-config-'));
    process.env.YANTRA_HOME = root;
    await writeFile(
      join(root, 'config.yaml'),
      [
        'ethics:',
        '  robots_enabled: true',
        '  rate_limit:',
        '    overrides:',
        '      example.com:',
        '        tokens_per_second: 4',
        '        burst: 5',
      ].join('\n'),
    );

    const config = await loadEthicsConfig();
    expect(config.robotsEnabled).toBe(true);
    expect(config.rateLimitOverrides.get('example.com')).toEqual({
      tokensPerSecond: 4,
      burst: 5,
    });
  });
});
