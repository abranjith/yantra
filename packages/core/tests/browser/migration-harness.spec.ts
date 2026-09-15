import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BrowserPlatform } from '@puppeteer/browsers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { resetPathCache } from '../../src/browser/paths.js';
import { beginMigrationBrowserFixture } from '../helpers/migration-browser.js';
import {
  MIGRATION_BROWSER_BUILD_ID,
  MIGRATION_BROWSER_ENV,
  UnsupportedMigrationBrowserPlatformError,
  provisionTestBrowser,
  validateMigrationBrowserExecutable,
} from '../helpers/provision-test-browser.js';

const coreRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

describe('@no-llm migration browser harness', () => {
  const originalHome = process.env.YANTRA_HOME;
  const originalBrowser = process.env[MIGRATION_BROWSER_ENV];

  afterEach(() => {
    if (originalHome === undefined) delete process.env.YANTRA_HOME;
    else process.env.YANTRA_HOME = originalHome;
    if (originalBrowser === undefined) delete process.env[MIGRATION_BROWSER_ENV];
    else process.env[MIGRATION_BROWSER_ENV] = originalBrowser;
    resetPathCache();
    vi.restoreAllMocks();
  });

  it('records the fixed build, detected platform, and exact installed executable', async () => {
    const executablePath = join(coreRoot, 'fixtures with spaces', 'chrome.exe');
    const installBrowser = vi.fn().mockResolvedValue({ executablePath });
    const validateExecutable = vi.fn().mockResolvedValue(undefined);

    const manifest = await provisionTestBrowser(join(coreRoot, '.test-cache'), {
      detectPlatform: () => BrowserPlatform.WIN64,
      installBrowser,
      validateExecutable,
    });

    expect(manifest).toMatchObject({
      buildId: MIGRATION_BROWSER_BUILD_ID,
      platform: BrowserPlatform.WIN64,
      executablePath,
    });
    expect(validateExecutable).toHaveBeenCalledWith(executablePath);
  });

  it('refuses unsupported architecture without attempting a download or fallback', async () => {
    const installBrowser = vi.fn();
    await expect(
      provisionTestBrowser(join(coreRoot, '.test-cache'), {
        detectPlatform: () => BrowserPlatform.LINUX_ARM,
        installBrowser,
      }),
    ).rejects.toBeInstanceOf(UnsupportedMigrationBrowserPlatformError);
    expect(installBrowser).not.toHaveBeenCalled();
  });

  it('rejects a missing executable before a suite launches', async () => {
    await expect(
      validateMigrationBrowserExecutable(join(coreRoot, 'missing', 'chrome')),
    ).rejects.toThrow(/Provisioned browser is missing/);
  });

  it('isolates YANTRA_HOME, passes the exact executable, and restores the environment', async () => {
    const developerHome = join(coreRoot, 'developer-home-that-must-not-be-used');
    const executablePath = process.execPath;
    process.env.YANTRA_HOME = developerHome;
    process.env[MIGRATION_BROWSER_ENV] = executablePath;

    const fixture = await beginMigrationBrowserFixture({ requireProvisioned: true });
    expect(fixture.yantraHome).not.toBe(developerHome);
    expect(process.env.YANTRA_HOME).toBe(fixture.yantraHome);
    expect(fixture.launchOptions).toEqual({
      browserSelection: { source: 'system', executablePath },
    });

    await fixture.cleanup();
    expect(process.env.YANTRA_HOME).toBe(developerHome);
  });
});
