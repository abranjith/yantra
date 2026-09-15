/**
 * The persisted browser binding round-trips as one whole selection.
 *
 * Two properties are asserted that no type can carry: an absent block reads as
 * `undefined` (not a configured `auto`), and the writer never hands the
 * filesystem a document the schema would refuse — which is what makes a
 * source change that drops a stale path atomic rather than a two-step edit.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ConfigBrowserSelectionReader,
  writeBrowserSelection,
} from '../../src/browser/config-selection.js';
import { resetPathCache } from '../../src/browser/paths.js';
import { configSchema } from '../../src/config/schema.js';

const CHROME = '/opt/google/chrome/chrome';

describe('@no-llm persisted browser selection', () => {
  let home: string;
  let path: string;
  const savedHome = process.env.YANTRA_HOME;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'yantra-browser-config-'));
    process.env.YANTRA_HOME = home;
    resetPathCache();
    path = join(home, 'config.yaml');
  });

  afterEach(async () => {
    if (savedHome === undefined) delete process.env.YANTRA_HOME;
    else process.env.YANTRA_HOME = savedHome;
    resetPathCache();
    await rm(home, { recursive: true, force: true }).catch(() => undefined);
  });

  describe('reader', () => {
    it('reports no configured selection when the file is absent', async () => {
      const reader = new ConfigBrowserSelectionReader({ configPath: path });
      await expect(reader.read()).resolves.toBeUndefined();
    });

    it('reports no configured selection when the file carries no browser block', async () => {
      await writeFile(path, 'version: 1\nretention:\n  runs_days: 7\n');
      const reader = new ConfigBrowserSelectionReader({ configPath: path });
      await expect(reader.read()).resolves.toBeUndefined();
    });

    it('distinguishes an explicitly configured auto from no choice at all', async () => {
      await writeFile(path, 'browser:\n  source: auto\n');
      const reader = new ConfigBrowserSelectionReader({ configPath: path });
      await expect(reader.read()).resolves.toEqual({ source: 'auto', executablePath: null });
    });

    it('maps a managed block onto the managed selection', async () => {
      await writeFile(path, 'browser:\n  source: managed\n');
      const reader = new ConfigBrowserSelectionReader({ configPath: path });
      await expect(reader.read()).resolves.toEqual({ source: 'managed', executablePath: null });
    });

    it('maps a custom system path onto the selection path', async () => {
      await writeFile(path, `browser:\n  source: system\n  executable_path: ${CHROME}\n`);
      const reader = new ConfigBrowserSelectionReader({ configPath: path });
      await expect(reader.read()).resolves.toEqual({
        source: 'system',
        executablePath: CHROME,
      });
    });

    // Silently reporting "no configured selection" would hide a configuration
    // failure the user has to fix, and would run a different browser than the
    // one they asked for.
    it('raises the configuration error instead of degrading to auto', async () => {
      await writeFile(path, `browser:\n  source: auto\n  executable_path: ${CHROME}\n`);
      const reader = new ConfigBrowserSelectionReader({ configPath: path });
      await expect(reader.read()).rejects.toThrow(/executable path is legal only with source/u);
    });
  });

  describe('writer', () => {
    it.each([
      ['auto', { source: 'auto', executablePath: null }],
      ['managed', { source: 'managed', executablePath: null }],
      ['system discovery', { source: 'system', executablePath: null }],
      ['system custom path', { source: 'system', executablePath: CHROME }],
    ] as const)('round-trips a %s selection through the reader', async (_label, selection) => {
      await writeBrowserSelection(selection, path);
      const reader = new ConfigBrowserSelectionReader({ configPath: path });
      await expect(reader.read()).resolves.toEqual(selection);
    });

    it('clears a previously set path in the same write', async () => {
      await writeBrowserSelection({ source: 'system', executablePath: CHROME }, path);
      await writeBrowserSelection({ source: 'auto', executablePath: null }, path);

      const reader = new ConfigBrowserSelectionReader({ configPath: path });
      await expect(reader.read()).resolves.toEqual({ source: 'auto', executablePath: null });
      // The key is present and null rather than merely deleted, so a later
      // reader cannot inherit a stale value from a partially edited document.
      expect(await readFile(path, 'utf8')).toMatch(/executable_path:\s*null/u);
    });

    it('never writes an intermediate document the schema would refuse', async () => {
      // Every state the file is left in must validate. The writer commits both
      // fields in one mutation, so a stale path under `auto` never reaches disk
      // even transiently.
      await writeBrowserSelection({ source: 'system', executablePath: CHROME }, path);
      expect(configSchema.safeParse(await parsed(path)).success).toBe(true);

      await writeBrowserSelection({ source: 'managed', executablePath: null }, path);
      expect(configSchema.safeParse(await parsed(path)).success).toBe(true);
    });

    it('ignores a path supplied with a non-system source rather than persisting it', async () => {
      await writeBrowserSelection({ source: 'managed', executablePath: CHROME } as never, path);
      const reader = new ConfigBrowserSelectionReader({ configPath: path });
      await expect(reader.read()).resolves.toEqual({ source: 'managed', executablePath: null });
    });

    it('preserves YAML comments and unrelated keys', async () => {
      await writeFile(
        path,
        [
          '# Yantra configuration — hand edited',
          'version: 1',
          'retention:',
          '  # keep two weeks of runs',
          '  runs_days: 14',
          '',
        ].join('\n'),
      );

      await writeBrowserSelection({ source: 'managed', executablePath: null }, path);

      const contents = await readFile(path, 'utf8');
      expect(contents).toContain('# Yantra configuration — hand edited');
      expect(contents).toContain('# keep two weeks of runs');
      expect(contents).toContain('runs_days: 14');
      expect(contents).toContain('source: managed');
    });
  });
});

async function parsed(path: string): Promise<unknown> {
  const { parse } = await import('yaml');
  return parse(await readFile(path, 'utf8'));
}
