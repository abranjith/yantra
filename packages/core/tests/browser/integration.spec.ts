import { describe, expect, it } from 'vitest';

import { LocalBrowserProvider } from '../../src/browser/provider.js';
import { LocalProfileStore } from '../../src/browser/profile-store.js';

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
    it(
      'launches real Chrome, opens about:blank, and closes cleanly',
      async () => {
        const profileStore = new LocalProfileStore();
        const provider = new LocalBrowserProvider({ profileStore });

        const session = await provider.launch({
          profile: { kind: 'ephemeral' },
          headless: true,
        });

        try {
          const page = await session.newPage();
          await page.goto('about:blank');
          const title = await page.evaluate(() => document.title);
          expect(title).toBe('');
        } finally {
          await session.close();
        }
      },
      30_000, // allow 30s for Chrome to start
    );

    it('detects Chrome on this machine', async () => {
      const provider = new LocalBrowserProvider({
        profileStore: new LocalProfileStore(),
      });
      const chrome = await provider.detectChrome();
      expect(chrome).not.toBeNull();
      expect(chrome?.majorVersion).toBeGreaterThanOrEqual(120);
    });
  },
);


