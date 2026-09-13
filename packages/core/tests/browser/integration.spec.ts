import { cp, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  managedExecutablePath,
  ManagedReadyRecordSchema,
} from '../../src/browser/managed-state.js';
import { managedBrowsersRoot, managedReadyPath } from '../../src/browser/paths.js';
import { LocalProfileStore } from '../../src/browser/profile-store.js';
import { LocalBrowserProvider } from '../../src/browser/provider.js';
import {
  beginMigrationBrowserFixture,
  readMigrationBrowserManifest,
  type MigrationBrowserFixture,
} from '../helpers/migration-browser.js';

/**
 * Per-OS integration test: launches real Chrome, opens about:blank, closes cleanly.
 * Gated on YANTRA_E2E_BROWSER=1 environment variable.
 * CI installs system Chrome on each OS runner before enabling this test.
 *
 * @see feature_chrome_launcher.md TASK-008
 */
describe.runIf(process.env['YANTRA_E2E_BROWSER'] === '1')(
  '@no-llm LocalBrowserProvider integration (real Chrome)',
  () => {
    let fixture: MigrationBrowserFixture;

    beforeAll(async () => {
      fixture = await beginMigrationBrowserFixture({ requireProvisioned: true });
    });

    afterAll(async () => {
      await fixture?.cleanup();
    });

    it('launches real Chrome, opens about:blank, and closes cleanly', async () => {
      const profileStore = new LocalProfileStore();
      const provider = new LocalBrowserProvider({ profileStore });

      const session = await provider.launch({
        profile: { kind: 'ephemeral' },
        headless: true,
        ...fixture.launchOptions,
      });

      try {
        const page = await session.newPage();
        await page.goto('about:blank');
        const title = await page.evaluate(() => document.title);
        expect(title).toBe('');
      } finally {
        await session.close();
      }
    }, 30_000); // allow 30s for Chrome to start

    it('reports the provisioned browser identity selected by the manifest', async () => {
      const provider = new LocalBrowserProvider({
        profileStore: new LocalProfileStore(),
      });
      const session = await provider.launch({
        profile: { kind: 'ephemeral' },
        headless: true,
        ...fixture.launchOptions,
      });
      try {
        const manifest = await readMigrationBrowserManifest();
        expect(session.chrome.path).toBe(manifest.executablePath);
        expect(session.chrome.version).toContain(manifest.buildId);
        expect(session.installation.ownership).toBe('external');
      } finally {
        await session.close();
      }
    });

    it('launches the same controlled executable through the selection contract', async () => {
      const provider = new LocalBrowserProvider({ profileStore: new LocalProfileStore() });

      const session = await provider.launch({
        profile: { kind: 'ephemeral' },
        headless: true,
        browserSelection: fixture.selection!,
      });

      try {
        expect(session.installation.selectionReason).toBe('custom-path');
        expect(session.installation.ownership).toBe('external');
        const page = await session.newPage();
        await page.goto('about:blank');
      } finally {
        await session.close();
      }
    }, 60_000);

    /**
     * Seeds the provisioned executable into a Yantra-managed layout so both
     * ownership classifications run against the same controlled binary — no
     * download, and no dependency on a real installation existing.
     */
    it('launches and shuts down a managed installation with no download', async () => {
      const manifest = await readMigrationBrowserManifest();
      const record = ManagedReadyRecordSchema.parse({
        schemaVersion: 1,
        installationId: 'integration',
        browser: 'chrome',
        platform: manifest.platform,
        buildId: manifest.buildId,
        cacheRootRelative: 'installation-integration',
        executableRelative: 'placeholder',
        verifiedAt: new Date().toISOString(),
      });
      const target = managedExecutablePath(record, managedBrowsersRoot()).path;
      // Copy the whole extracted build so the managed tree is a real installation.
      await mkdir(dirname(target), { recursive: true });
      await cp(dirname(manifest.executablePath), dirname(target), { recursive: true });
      const seeded = ManagedReadyRecordSchema.parse({
        ...record,
        executableRelative: target
          .slice(join(managedBrowsersRoot(), record.cacheRootRelative).length + 1)
          .split(/[\\/]/u)
          .join('/'),
      });
      await mkdir(dirname(managedReadyPath()), { recursive: true });
      await writeFile(managedReadyPath(), JSON.stringify(seeded), 'utf8');

      const provider = new LocalBrowserProvider({ profileStore: new LocalProfileStore() });
      const session = await provider.launch({
        profile: { kind: 'ephemeral' },
        headless: true,
        browserSelection: { source: 'managed', executablePath: null },
      });

      try {
        expect(session.installation.ownership).toBe('managed');
        expect(session.chrome.source).toBe('managed');
        const page = await session.newPage();
        await page.goto('about:blank');
      } finally {
        await session.close();
      }

      // The reservation is released only after the process exited, so a second
      // managed launch is immediately possible.
      const again = await provider.launch({
        profile: { kind: 'ephemeral' },
        headless: true,
        browserSelection: { source: 'managed', executablePath: null },
      });
      await again.close();
    }, 180_000);
  },
);
