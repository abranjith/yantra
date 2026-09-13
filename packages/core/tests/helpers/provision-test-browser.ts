import { constants } from 'node:fs';
import { access, appendFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  Browser,
  BrowserPlatform,
  computeExecutablePath,
  detectBrowserPlatform,
  install,
  type InstalledBrowser,
} from '@puppeteer/browsers';

export const MIGRATION_BROWSER_BUILD_ID = '152.0.7977.75';
export const MIGRATION_BROWSER_ENV = 'YANTRA_TEST_BROWSER_PATH';
export const MIGRATION_BROWSER_MANIFEST_ENV = 'YANTRA_TEST_BROWSER_MANIFEST';

const SUPPORTED_PLATFORMS = new Set<BrowserPlatform>([
  BrowserPlatform.LINUX,
  BrowserPlatform.MAC,
  BrowserPlatform.MAC_ARM,
  BrowserPlatform.WIN32,
  BrowserPlatform.WIN64,
]);

export interface MigrationBrowserManifest {
  readonly browser: typeof Browser.CHROME;
  readonly buildId: string;
  readonly platform: BrowserPlatform;
  readonly executablePath: string;
  readonly cacheDir: string;
}

export interface ProvisionTestBrowserDependencies {
  readonly detectPlatform?: () => BrowserPlatform | undefined;
  readonly installBrowser?: (options: {
    readonly browser: Browser;
    readonly buildId: string;
    readonly cacheDir: string;
    readonly platform: BrowserPlatform;
    readonly installDeps: false;
  }) => Promise<Pick<InstalledBrowser, 'executablePath'>>;
  readonly validateExecutable?: (path: string) => Promise<void>;
}

export class UnsupportedMigrationBrowserPlatformError extends Error {
  constructor(readonly detectedPlatform: BrowserPlatform | undefined) {
    super(
      `Chrome for Testing ${MIGRATION_BROWSER_BUILD_ID} is unsupported on platform ${detectedPlatform ?? 'unknown'}; no fallback platform was selected.`,
    );
    this.name = 'UnsupportedMigrationBrowserPlatformError';
  }
}

/** Fail before a browser suite starts when the selected executable is unusable. */
export async function validateMigrationBrowserExecutable(executablePath: string): Promise<void> {
  if (!isAbsolute(executablePath)) {
    throw new Error(`${MIGRATION_BROWSER_ENV} must be an absolute executable path.`);
  }
  const info = await stat(executablePath).catch((cause: unknown) => {
    throw new Error(`Provisioned browser is missing: ${executablePath}`, { cause });
  });
  if (!info.isFile()) {
    throw new Error(`Provisioned browser path is not a file: ${executablePath}`);
  }
  await access(executablePath, constants.X_OK).catch((cause: unknown) => {
    throw new Error(`Provisioned browser is not executable: ${executablePath}`, { cause });
  });
}

/**
 * Install the fixed migration fixture through the browsers package API.
 * The cache root is caller-owned and never falls back to a global cache.
 */
export async function provisionTestBrowser(
  cacheDir: string,
  dependencies: ProvisionTestBrowserDependencies = {},
): Promise<MigrationBrowserManifest> {
  const platform = (dependencies.detectPlatform ?? detectBrowserPlatform)();
  if (platform === undefined || !SUPPORTED_PLATFORMS.has(platform)) {
    throw new UnsupportedMigrationBrowserPlatformError(platform);
  }

  const absoluteCacheDir = resolve(cacheDir);
  await mkdir(absoluteCacheDir, { recursive: true });
  const installed = await (dependencies.installBrowser ?? install)({
    browser: Browser.CHROME,
    buildId: MIGRATION_BROWSER_BUILD_ID,
    cacheDir: absoluteCacheDir,
    platform,
    installDeps: false,
  });
  const executablePath = resolve(
    installed.executablePath ||
      computeExecutablePath({
        browser: Browser.CHROME,
        buildId: MIGRATION_BROWSER_BUILD_ID,
        cacheDir: absoluteCacheDir,
        platform,
      }),
  );
  await (dependencies.validateExecutable ?? validateMigrationBrowserExecutable)(executablePath);

  return {
    browser: Browser.CHROME,
    buildId: MIGRATION_BROWSER_BUILD_ID,
    platform,
    executablePath,
    cacheDir: absoluteCacheDir,
  };
}

export async function writeMigrationBrowserManifest(
  manifestPath: string,
  manifest: MigrationBrowserManifest,
): Promise<void> {
  await mkdir(resolve(manifestPath, '..'), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

function valueAfter(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

async function main(argv: readonly string[]): Promise<void> {
  const manifestPath = resolve(
    valueAfter(argv, '--manifest') ?? join(tmpdir(), 'yantra-migration-browser.json'),
  );
  const cacheDir = resolve(valueAfter(argv, '--cache-dir') ?? join(tmpdir(), 'yantra-cft-cache'));
  const githubEnvPath = valueAfter(argv, '--github-env') ?? process.env.GITHUB_ENV;
  const manifest = await provisionTestBrowser(cacheDir);
  await writeMigrationBrowserManifest(manifestPath, manifest);

  if (githubEnvPath !== undefined) {
    if (/\r|\n/.test(manifest.executablePath) || /\r|\n/.test(manifestPath)) {
      throw new Error('Provisioned browser paths may not contain line breaks.');
    }
    await appendFile(
      githubEnvPath,
      `${MIGRATION_BROWSER_ENV}=${manifest.executablePath}\n${MIGRATION_BROWSER_MANIFEST_ENV}=${manifestPath}\n`,
      'utf8',
    );
  }

  process.stdout.write(`${JSON.stringify(manifest)}\n`);
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
