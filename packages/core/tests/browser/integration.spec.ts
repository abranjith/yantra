import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
      } finally {
        await session.close();
      }
    });
  },
);
