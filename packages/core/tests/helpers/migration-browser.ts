import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { BrowserSelection } from '../../src/browser/installation-types.js';
import { resetPathCache } from '../../src/browser/paths.js';
import type { LaunchOptions } from '../../src/browser/types.js';

import {
  MIGRATION_BROWSER_ENV,
  MIGRATION_BROWSER_MANIFEST_ENV,
  type MigrationBrowserManifest,
  validateMigrationBrowserExecutable,
} from './provision-test-browser.js';

export interface MigrationBrowserFixture {
  readonly yantraHome: string;
  readonly executablePath: string | undefined;
  readonly launchOptions: Pick<LaunchOptions, 'chromeOverridePath'> | Record<string, never>;
  /** The same choice expressed through the current selection contract. */
  readonly selection: BrowserSelection | undefined;
  cleanup(): Promise<void>;
}

/**
 * Isolate migration suites from developer state and route launches through the
 * explicitly provisioned browser when one was supplied by CI.
 */
export async function beginMigrationBrowserFixture(options?: {
  readonly requireProvisioned?: boolean;
}): Promise<MigrationBrowserFixture> {
  const previousHome = process.env.YANTRA_HOME;
  const yantraHome = await mkdtemp(join(tmpdir(), 'yantra-migration-home-'));
  const configuredPath = process.env[MIGRATION_BROWSER_ENV]?.trim();

  if (options?.requireProvisioned === true && !configuredPath) {
    await rm(yantraHome, { recursive: true, force: true });
    throw new Error(
      `${MIGRATION_BROWSER_ENV} is required when browser migration coverage is enabled.`,
    );
  }
  if (configuredPath) await validateMigrationBrowserExecutable(configuredPath);

  process.env.YANTRA_HOME = yantraHome;
  resetPathCache();
  let cleaned = false;

  return {
    yantraHome,
    executablePath: configuredPath,
    launchOptions: configuredPath ? { chromeOverridePath: configuredPath } : {},
    selection: configuredPath
      ? { source: 'system' as const, executablePath: configuredPath }
      : undefined,
    async cleanup(): Promise<void> {
      if (cleaned) return;
      cleaned = true;
      if (previousHome === undefined) delete process.env.YANTRA_HOME;
      else process.env.YANTRA_HOME = previousHome;
      resetPathCache();
      await rm(yantraHome, { recursive: true, force: true });
    },
  };
}

export async function readMigrationBrowserManifest(): Promise<MigrationBrowserManifest> {
  const manifestPath = process.env[MIGRATION_BROWSER_MANIFEST_ENV]?.trim();
  if (!manifestPath) throw new Error(`${MIGRATION_BROWSER_MANIFEST_ENV} is not set.`);
  const parsed = JSON.parse(
    await readFile(resolve(manifestPath), 'utf8'),
  ) as MigrationBrowserManifest;
  if (parsed.executablePath !== process.env[MIGRATION_BROWSER_ENV]) {
    throw new Error('Migration browser manifest and executable environment disagree.');
  }
  return parsed;
}
